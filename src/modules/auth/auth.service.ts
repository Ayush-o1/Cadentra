import type { Config } from '../../config/env.js';
import {
  DUMMY_PASSWORD_HASH,
  generateToken,
  hashPassword,
  sha256Hex,
  verifyPassword,
} from '../../lib/crypto.js';
import { isUniqueViolation, type Db } from '../../lib/db.js';
import { AppError, conflict, notFound, unauthorized, validationFailed } from '../../lib/errors.js';
import type { SystemMailer } from '../../email/system-mail.js';
import type { AuthTokenPurpose } from '../../generated/prisma/client.js';
import { recordActivity } from '../activity/activity.service.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';

export type ClientInfo = { userAgent: string | undefined; ip: string | undefined };

export type SessionIdentity = {
  user: { id: number; email: string; name: string; emailVerified: boolean };
  workspace: { id: number; name: string; role: 'owner' | 'member' };
};

export type AuthService = ReturnType<typeof createAuthService>;

const RESET_TTL_MS = 60 * 60 * 1000;
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const invalidLink = () =>
  new AppError(400, 'INVALID_TOKEN', 'This link is invalid, has expired or was already used');

export function createAuthService(db: Db, config: Config, mailer: SystemMailer) {
  /** Replaces any unused token of this kind with a fresh one and returns the secret to e-mail. */
  async function issueToken(
    userId: number,
    purpose: AuthTokenPurpose,
    ttlMs: number,
  ): Promise<string> {
    const token = generateToken();
    await db.$transaction([
      db.authToken.deleteMany({ where: { userId, purpose, usedAt: null } }),
      db.authToken.create({
        data: {
          userId,
          purpose,
          tokenHash: sha256Hex(token),
          expiresAt: new Date(Date.now() + ttlMs),
        },
      }),
    ]);
    return token;
  }

  /** Links carry the secret in the URL fragment, which browsers never send to the server. */
  const linkFor = (path: string, token: string) => `${config.appUrl}${path}#token=${token}`;

  async function sendVerification(user: { id: number; email: string; name: string }) {
    const token = await issueToken(user.id, 'email_verification', VERIFICATION_TTL_MS);
    await mailer.sendEmailVerification({
      to: user.email,
      name: user.name,
      link: linkFor('/verify-email', token),
    });
  }

  async function openSession(userId: number, client: ClientInfo): Promise<string> {
    const token = generateToken();
    await db.session.create({
      data: {
        userId,
        tokenHash: sha256Hex(token),
        userAgent: client.userAgent?.slice(0, 255) ?? null,
        ipAddress: client.ip?.slice(0, 45) ?? null,
        expiresAt: new Date(Date.now() + config.session.absoluteTimeoutMs),
      },
    });
    return token;
  }

  async function identityFor(userId: number): Promise<SessionIdentity> {
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        memberships: { orderBy: { createdAt: 'asc' }, take: 1, include: { workspace: true } },
      },
    });
    const membership = user.memberships[0];
    if (!membership) throw unauthorized();
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerifiedAt !== null,
      },
      workspace: {
        id: membership.workspace.id,
        name: membership.workspace.name,
        role: membership.role,
      },
    };
  }

  return {
    identityFor,

    /** Creates the user, their workspace and the owner membership atomically. */
    async register(input: RegisterInput, client: ClientInfo) {
      const passwordHash = await hashPassword(input.password);
      let userId: number;
      try {
        userId = await db.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: { email: input.email, name: input.name, passwordHash },
          });
          const workspace = await tx.workspace.create({
            data: { name: input.workspaceName ?? `${input.name}'s workspace` },
          });
          await tx.workspaceMember.create({
            data: { workspaceId: workspace.id, userId: user.id, role: 'owner' },
          });
          await recordActivity(tx, {
            workspaceId: workspace.id,
            userId: user.id,
            action: 'workspace.created',
            entityType: 'workspace',
            entityId: workspace.id,
          });
          return user.id;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
        }
        throw error;
      }
      // Best effort and not awaited: signing up must not wait for, or fail because of, the mail provider.
      void db.user
        .findUniqueOrThrow({ where: { id: userId } })
        .then(sendVerification)
        .catch(() => undefined);
      return { token: await openSession(userId, client), identity: await identityFor(userId) };
    },

    async login(input: LoginInput, client: ClientInfo) {
      const user = await db.user.findUnique({ where: { email: input.email } });
      // Verify against a dummy hash for unknown accounts so timing does not reveal them.
      const valid = await verifyPassword(user?.passwordHash ?? DUMMY_PASSWORD_HASH, input.password);
      if (!user || !valid) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect');
      }
      return { token: await openSession(user.id, client), identity: await identityFor(user.id) };
    },

    /**
     * Always looks the same to the caller whether or not the address has an account, so the
     * form cannot be used to find out who is registered. The email is sent after responding.
     */
    async requestPasswordReset(email: string): Promise<void> {
      const user = await db.user.findUnique({ where: { email } });
      if (!user) return;
      const token = await issueToken(user.id, 'password_reset', RESET_TTL_MS);
      void mailer.sendPasswordReset({
        to: user.email,
        name: user.name,
        link: linkFor('/reset-password', token),
      });
    },

    /**
     * Sets a new password from an e-mailed token. The token is spent in the same transaction, so
     * it cannot be used twice, and every session of the account is signed out. Having received the
     * email also proves the address, so it counts as verification.
     */
    async resetPassword(token: string, newPassword: string): Promise<void> {
      const row = await db.authToken.findUnique({ where: { tokenHash: sha256Hex(token) } });
      const now = new Date();
      if (!row || row.purpose !== 'password_reset' || row.usedAt || row.expiresAt <= now) {
        throw invalidLink();
      }
      const passwordHash = await hashPassword(newPassword);
      await db.$transaction(async (tx) => {
        const spent = await tx.authToken.updateMany({
          where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (spent.count !== 1) throw invalidLink();
        await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
        await tx.user.updateMany({
          where: { id: row.userId, emailVerifiedAt: null },
          data: { emailVerifiedAt: now },
        });
        await tx.authToken.deleteMany({
          where: { userId: row.userId, purpose: 'password_reset', usedAt: null },
        });
        await tx.session.deleteMany({ where: { userId: row.userId } });
      });
    },

    async verifyEmail(token: string): Promise<void> {
      const row = await db.authToken.findUnique({ where: { tokenHash: sha256Hex(token) } });
      const now = new Date();
      if (!row || row.purpose !== 'email_verification' || row.usedAt || row.expiresAt <= now) {
        throw invalidLink();
      }
      await db.$transaction(async (tx) => {
        const spent = await tx.authToken.updateMany({
          where: { id: row.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (spent.count !== 1) throw invalidLink();
        await tx.user.updateMany({
          where: { id: row.userId, emailVerifiedAt: null },
          data: { emailVerifiedAt: now },
        });
      });
    },

    /** Returns false when the address was already verified and nothing was sent. */
    async resendVerification(userId: number): Promise<boolean> {
      const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.emailVerifiedAt) return false;
      void sendVerification(user).catch(() => undefined);
      return true;
    },

    async logout(token: string): Promise<void> {
      await db.session.deleteMany({ where: { tokenHash: sha256Hex(token) } });
    },

    async updateProfile(userId: number, name: string) {
      await db.user.update({ where: { id: userId }, data: { name } });
      return identityFor(userId);
    },

    /** Changes the password and signs out every other session of the account. */
    async changePassword(
      userId: number,
      currentSessionId: number,
      currentPassword: string,
      newPassword: string,
    ): Promise<void> {
      const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
      if (!(await verifyPassword(user.passwordHash, currentPassword))) {
        throw validationFailed('The current password is incorrect', [
          { path: 'currentPassword', message: 'The current password is incorrect' },
        ]);
      }
      const passwordHash = await hashPassword(newPassword);
      await db.$transaction([
        db.user.update({ where: { id: userId }, data: { passwordHash } }),
        db.session.deleteMany({ where: { userId, id: { not: currentSessionId } } }),
      ]);
    },

    async listSessions(userId: number, currentSessionId: number) {
      const sessions = await db.session.findMany({
        where: { userId, expiresAt: { gt: new Date() } },
        orderBy: { lastSeenAt: 'desc' },
      });
      return sessions.map((session) => ({
        id: session.id,
        userAgent: session.userAgent,
        ipAddress: session.ipAddress,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        current: session.id === currentSessionId,
      }));
    },

    async revokeSession(userId: number, sessionId: number): Promise<void> {
      const { count } = await db.session.deleteMany({ where: { id: sessionId, userId } });
      if (count === 0) throw notFound('Session');
    },
  };
}

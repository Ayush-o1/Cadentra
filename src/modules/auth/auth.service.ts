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
import { recordActivity } from '../activity/activity.service.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';

export type ClientInfo = { userAgent: string | undefined; ip: string | undefined };

export type SessionIdentity = {
  user: { id: number; email: string; name: string };
  workspace: { id: number; name: string; role: 'owner' | 'member' };
};

export type AuthService = ReturnType<typeof createAuthService>;

export function createAuthService(db: Db, config: Config) {
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
      user: { id: user.id, email: user.email, name: user.name },
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

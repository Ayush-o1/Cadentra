import type { Request, RequestHandler } from 'express';
import type { Config } from '../config/env.js';
import type { Db } from '../lib/db.js';
import { sha256Hex } from '../lib/crypto.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { readCookie } from '../lib/http.js';
import type { AuthContext } from '../types/express.js';

const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

/** Looks up the session behind the request cookie. Returns null when there is no valid session. */
export function createAuthResolver(config: Config, db: Db) {
  return async function resolveAuth(req: Request): Promise<AuthContext | null> {
    const token = readCookie(req, config.session.cookieName);
    if (!token) return null;

    const now = new Date();
    const session = await db.session.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: {
        user: { include: { memberships: { orderBy: { createdAt: 'asc' }, take: 1 } } },
      },
    });
    const membership = session?.user.memberships[0];
    const idleDeadline = session ? session.lastSeenAt.getTime() + config.session.idleTimeoutMs : 0;
    if (!session || !membership || session.expiresAt <= now || idleDeadline <= now.getTime()) {
      return null;
    }

    if (now.getTime() - session.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
      await db.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    }
    return {
      userId: session.userId,
      sessionId: session.id,
      workspaceId: membership.workspaceId,
      role: membership.role,
    };
  };
}

export function createRequireAuth(config: Config, db: Db): RequestHandler {
  const resolveAuth = createAuthResolver(config, db);
  return async (req, _res, next) => {
    const auth = await resolveAuth(req);
    if (!auth) throw unauthorized();
    req.auth = auth;
    next();
  };
}

export const requireOwner: RequestHandler = (req, _res, next) => {
  if (getAuth(req).role !== 'owner') throw forbidden('Only the workspace owner can do that');
  next();
};

export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

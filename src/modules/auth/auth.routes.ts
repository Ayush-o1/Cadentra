import { Router, type CookieOptions, type Request, type Response } from 'express';
import type { Config } from '../../config/env.js';
import type { Db } from '../../lib/db.js';
import { noContent, parseId, readCookie } from '../../lib/http.js';
import { createAuthResolver, createRequireAuth, getAuth } from '../../middleware/auth.js';
import { createRateLimiter, emailKey } from '../../middleware/rate-limit.js';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  updateProfileSchema,
} from './auth.schemas.js';
import { createAuthService, type ClientInfo } from './auth.service.js';

function clientInfo(req: Request): ClientInfo {
  return { userAgent: req.get('user-agent'), ip: req.ip };
}

export function createAuthRouter(config: Config, db: Db): Router {
  const router = Router();
  const service = createAuthService(db, config);
  const requireAuth = createRequireAuth(config, db);
  const resolveAuth = createAuthResolver(config, db);

  const cookieOptions: CookieOptions = {
    httpOnly: true,
    secure: config.session.secureCookie,
    sameSite: 'lax',
    path: '/',
  };
  const startSession = (res: Response, token: string) =>
    res.cookie(config.session.cookieName, token, {
      ...cookieOptions,
      maxAge: config.session.absoluteTimeoutMs,
    });

  router.post('/auth/register', createRateLimiter(config.rateLimits.register), async (req, res) => {
    const { token, identity } = await service.register(
      registerSchema.parse(req.body),
      clientInfo(req),
    );
    startSession(res, token);
    res.status(201).json({ data: identity });
  });

  router.post(
    '/auth/login',
    createRateLimiter(config.rateLimits.loginPerIp, { skipSuccessfulRequests: true }),
    createRateLimiter(config.rateLimits.loginPerAccount, {
      skipSuccessfulRequests: true,
      key: emailKey,
    }),
    async (req, res) => {
      const { token, identity } = await service.login(loginSchema.parse(req.body), clientInfo(req));
      startSession(res, token);
      res.json({ data: identity });
    },
  );

  router.post('/auth/logout', async (req, res) => {
    const token = readCookie(req, config.session.cookieName);
    if (token) await service.logout(token);
    res.clearCookie(config.session.cookieName, cookieOptions);
    noContent(res);
  });

  // The frontend asks this on every page load. Being signed out is a normal answer, not an error.
  router.get('/auth/session', async (req, res) => {
    const auth = await resolveAuth(req);
    res.json({ data: auth ? await service.identityFor(auth.userId) : null });
  });

  router.get('/auth/me', requireAuth, async (req, res) => {
    res.json({ data: await service.identityFor(getAuth(req).userId) });
  });

  router.patch('/account/profile', requireAuth, async (req, res) => {
    const { name } = updateProfileSchema.parse(req.body);
    res.json({ data: await service.updateProfile(getAuth(req).userId, name) });
  });

  router.post('/account/password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const auth = getAuth(req);
    await service.changePassword(auth.userId, auth.sessionId, currentPassword, newPassword);
    noContent(res);
  });

  router.get('/account/sessions', requireAuth, async (req, res) => {
    const auth = getAuth(req);
    res.json({ data: await service.listSessions(auth.userId, auth.sessionId) });
  });

  router.delete('/account/sessions/:id', requireAuth, async (req, res) => {
    await service.revokeSession(getAuth(req).userId, parseId(req.params['id'], 'Session'));
    noContent(res);
  });

  return router;
}

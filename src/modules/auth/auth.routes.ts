import { Router, type CookieOptions, type Request, type Response } from 'express';
import type { Config } from '../../config/env.js';
import type { Db } from '../../lib/db.js';
import { noContent, parseId, readCookie } from '../../lib/http.js';
import { createAuthResolver, createRequireAuth, getAuth } from '../../middleware/auth.js';
import { createRateLimiter, emailKey } from '../../middleware/rate-limit.js';
import type { SystemMailer } from '../../email/system-mail.js';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  updateProfileSchema,
  verifyEmailSchema,
} from './auth.schemas.js';
import { createAuthService, type ClientInfo } from './auth.service.js';

function clientInfo(req: Request): ClientInfo {
  return { userAgent: req.get('user-agent'), ip: req.ip };
}

export function createAuthRouter(config: Config, db: Db, mailer: SystemMailer): Router {
  const router = Router();
  const service = createAuthService(db, config, mailer);
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

  // Same answer whether or not the address has an account.
  router.post(
    '/auth/forgot-password',
    createRateLimiter(config.rateLimits.passwordResetPerIp),
    createRateLimiter(config.rateLimits.passwordResetPerAccount, { key: emailKey }),
    async (req, res) => {
      await service.requestPasswordReset(forgotPasswordSchema.parse(req.body).email);
      res.status(202).json({ data: { accepted: true } });
    },
  );

  router.post(
    '/auth/reset-password',
    createRateLimiter(config.rateLimits.passwordResetPerIp),
    async (req, res) => {
      const { token, newPassword } = resetPasswordSchema.parse(req.body);
      await service.resetPassword(token, newPassword);
      noContent(res);
    },
  );

  router.post(
    '/auth/verify-email',
    createRateLimiter(config.rateLimits.passwordResetPerIp),
    async (req, res) => {
      await service.verifyEmail(verifyEmailSchema.parse(req.body).token);
      noContent(res);
    },
  );

  router.post(
    '/account/verification-email',
    requireAuth,
    createRateLimiter(config.rateLimits.verificationResend, {
      key: (req) => `verify:${getAuth(req).userId}`,
    }),
    async (req, res) => {
      const sent = await service.resendVerification(getAuth(req).userId);
      res.status(202).json({ data: { sent } });
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

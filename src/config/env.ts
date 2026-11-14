import { z } from 'zod';

const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    APP_URL: z.url().default('http://localhost:3000'),
    APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
    // How many reverse proxies sit in front of the app: `false`, or a count such as `1`.
    // `true` is accepted as 1. Never "trust everything": a client could then forge X-Forwarded-For
    // and dodge the rate limits.
    TRUST_PROXY: z
      .string()
      .regex(/^(true|false|\d{1,2})$/, 'must be false, true (one proxy) or a number of proxies')
      .default('false')
      .transform((value): false | number =>
        value === 'false' ? false : value === 'true' ? 1 : Number(value),
      ),

    RUN_WORKER: booleanFromString.default(true),
    WORKER_POLL_MS: z.coerce.number().int().min(50).default(5000),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
    WORKER_MAX_SENDS_PER_SECOND: z.coerce.number().min(0.1).max(10).default(5),
    TICK_TOKEN: z.string().min(24).optional(),
    QUEUE_CLAIM_MODE: z.enum(['skip-locked', 'conditional-update']).default('skip-locked'),

    EMAIL_PROVIDER: z.enum(['fake', 'resend']).default('fake'),
    RESEND_API_KEY: z.string().min(1).optional(),
    RESEND_WEBHOOK_SECRET: z.string().min(1).optional(),
    // Sender of Cadentra's own emails (password reset, address verification), not campaigns.
    SYSTEM_EMAIL_FROM: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[^\r\n]+$/, 'must be a single line')
      .optional(),
    // When true, launching a campaign requires the account's email address to be verified.
    REQUIRE_VERIFIED_EMAIL: booleanFromString.default(false),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_PROVIDER === 'resend') {
      for (const key of ['RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'SYSTEM_EMAIL_FROM'] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required when EMAIL_PROVIDER=resend`,
          });
        }
      }
    }
    if (env.NODE_ENV === 'production' && !env.APP_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_URL'],
        message: 'APP_URL must use https in production',
      });
    }
  });

export type RateLimit = { windowMs: number; limit: number };
export type RateLimits = {
  api: RateLimit;
  loginPerIp: RateLimit;
  loginPerAccount: RateLimit;
  register: RateLimit;
  passwordResetPerIp: RateLimit;
  passwordResetPerAccount: RateLimit;
  verificationResend: RateLimit;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export type Config = {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  logLevel: z.infer<typeof envSchema>['LOG_LEVEL'];
  databaseUrl: string;
  appUrl: string;
  appSecret: string;
  trustProxy: false | number;
  session: {
    cookieName: string;
    secureCookie: boolean;
    idleTimeoutMs: number;
    absoluteTimeoutMs: number;
  };
  rateLimits: RateLimits;
  worker: {
    enabled: boolean;
    pollMs: number;
    concurrency: number;
    maxSendsPerSecond: number;
    claimMode: 'skip-locked' | 'conditional-update';
    tickToken: string | undefined;
  };
  email: {
    provider: 'fake' | 'resend';
    resendApiKey: string | undefined;
    resendWebhookSecret: string | undefined;
    systemFrom: string;
  };
  auth: { requireVerifiedEmail: boolean };
};

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'ConfigError';
  }
}

export function loadConfig(raw: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` in a .env file or a blank field in a hosting dashboard means "not set", not "empty".
  const source = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ''));
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  const env = parsed.data;
  const secureCookie = env.APP_URL.startsWith('https://');
  return {
    env: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    appUrl: env.APP_URL.replace(/\/+$/, ''),
    appSecret: env.APP_SECRET,
    trustProxy: env.TRUST_PROXY,
    session: {
      // The __Host- prefix makes browsers reject the cookie unless it is Secure, host-only and Path=/.
      cookieName: secureCookie ? '__Host-cadentra_sid' : 'cadentra_sid',
      secureCookie,
      idleTimeoutMs: 7 * DAY_MS,
      absoluteTimeoutMs: 30 * DAY_MS,
    },
    rateLimits: defaultRateLimits(env.NODE_ENV === 'test'),
    worker: {
      enabled: env.RUN_WORKER,
      pollMs: env.WORKER_POLL_MS,
      concurrency: env.WORKER_CONCURRENCY,
      maxSendsPerSecond: env.WORKER_MAX_SENDS_PER_SECOND,
      claimMode: env.QUEUE_CLAIM_MODE,
      tickToken: env.TICK_TOKEN,
    },
    email: {
      provider: env.EMAIL_PROVIDER,
      resendApiKey: env.RESEND_API_KEY,
      resendWebhookSecret: env.RESEND_WEBHOOK_SECRET,
      systemFrom: env.SYSTEM_EMAIL_FROM ?? 'Cadentra <no-reply@cadentra.invalid>',
    },
    auth: { requireVerifiedEmail: env.REQUIRE_VERIFIED_EMAIL },
  };
}

function defaultRateLimits(relaxed: boolean): RateLimits {
  const minutes = (count: number) => count * 60 * 1000;
  if (relaxed) {
    const generous = { windowMs: minutes(15), limit: 100_000 };
    return {
      api: generous,
      loginPerIp: generous,
      loginPerAccount: generous,
      register: generous,
      passwordResetPerIp: generous,
      passwordResetPerAccount: generous,
      verificationResend: generous,
    };
  }
  return {
    api: { windowMs: minutes(1), limit: 600 },
    loginPerIp: { windowMs: minutes(15), limit: 30 },
    loginPerAccount: { windowMs: minutes(15), limit: 5 },
    register: { windowMs: minutes(60), limit: 10 },
    passwordResetPerIp: { windowMs: minutes(60), limit: 10 },
    passwordResetPerAccount: { windowMs: minutes(60), limit: 3 },
    verificationResend: { windowMs: minutes(60), limit: 5 },
  };
}

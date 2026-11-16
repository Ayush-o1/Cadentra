import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';

const validEnv = {
  DATABASE_URL: 'mysql://user:pass@localhost:3306/cadentra',
  APP_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(3000);
    expect(config.email.provider).toBe('fake');
    expect(config.worker.enabled).toBe(true);
    expect(config.appUrl).toBe('http://localhost:3000');
  });

  it('reports every missing or invalid variable at once', () => {
    try {
      loadConfig({ PORT: 'not-a-number' });
      expect.unreachable('loadConfig should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('APP_SECRET');
      expect(message).toContain('PORT');
    }
  });

  it('requires Resend credentials when the Resend provider is selected', () => {
    expect(() => loadConfig({ ...validEnv, EMAIL_PROVIDER: 'resend' })).toThrow(/RESEND_API_KEY/);
    const config = loadConfig({
      ...validEnv,
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test',
      RESEND_WEBHOOK_SECRET: 'whsec_test',
      SYSTEM_EMAIL_FROM: 'Cadentra <system@example.org>',
    });
    expect(config.email.provider).toBe('resend');
    expect(config.email.systemFrom).toBe('Cadentra <system@example.org>');
  });

  it('needs a sender for its own emails when sending for real, and rejects multi-line values', () => {
    const resend = {
      ...validEnv,
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test',
      RESEND_WEBHOOK_SECRET: 'whsec_test',
    };
    expect(() => loadConfig(resend)).toThrow(/SYSTEM_EMAIL_FROM/);
    expect(() =>
      loadConfig({ ...resend, SYSTEM_EMAIL_FROM: 'a@example.org\r\nBcc: x@example.org' }),
    ).toThrow(/single line/);
  });

  it('does not require a verified email unless asked', () => {
    expect(loadConfig(validEnv).auth.requireVerifiedEmail).toBe(false);
    expect(
      loadConfig({ ...validEnv, REQUIRE_VERIFIED_EMAIL: 'true' }).auth.requireVerifiedEmail,
    ).toBe(true);
  });

  it('defaults the queue claim to SKIP LOCKED and accepts the alternative', () => {
    expect(loadConfig(validEnv).worker.claimMode).toBe('skip-locked');
    expect(
      loadConfig({ ...validEnv, QUEUE_CLAIM_MODE: 'conditional-update' }).worker.claimMode,
    ).toBe('conditional-update');
    expect(() => loadConfig({ ...validEnv, QUEUE_CLAIM_MODE: 'nope' })).toThrow(/QUEUE_CLAIM_MODE/);
  });

  it('takes a number of proxies, never trust-everything', () => {
    expect(loadConfig(validEnv).trustProxy).toBe(false);
    expect(loadConfig({ ...validEnv, TRUST_PROXY: 'true' }).trustProxy).toBe(1);
    expect(loadConfig({ ...validEnv, TRUST_PROXY: '2' }).trustProxy).toBe(2);
    expect(() => loadConfig({ ...validEnv, TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/);
  });

  it('rejects a non-https APP_URL in production', () => {
    expect(() =>
      loadConfig({ ...validEnv, NODE_ENV: 'production', APP_URL: 'http://example.org' }),
    ).toThrow(/https/);
  });

  it('strips trailing slashes from APP_URL', () => {
    expect(loadConfig({ ...validEnv, APP_URL: 'https://app.example.org/' }).appUrl).toBe(
      'https://app.example.org',
    );
  });

  it("uses Render's own address when APP_URL is not set, and prefers an explicit APP_URL", () => {
    const render = {
      ...validEnv,
      NODE_ENV: 'production',
      RENDER_EXTERNAL_URL: 'https://x.onrender.com',
    };
    expect(loadConfig(render).appUrl).toBe('https://x.onrender.com');
    expect(loadConfig({ ...render, APP_URL: 'https://app.example.org' }).appUrl).toBe(
      'https://app.example.org',
    );
  });

  it('treats blank values as unset', () => {
    const config = loadConfig({ ...validEnv, TICK_TOKEN: '', RESEND_API_KEY: '', LOG_LEVEL: '' });
    expect(config.worker.tickToken).toBeUndefined();
    expect(config.logLevel).toBe('info');
    expect(() => loadConfig({ ...validEnv, APP_SECRET: '' })).toThrow(/APP_SECRET/);
  });

  it('loads .env.example as shipped once APP_SECRET is filled in', () => {
    const shipped = parseEnv(readFileSync('.env.example', 'utf8'));
    expect(() => loadConfig({ ...shipped, APP_SECRET: 'x'.repeat(32) })).not.toThrow();
  });

  it('loads .env.production.example once its secrets and https URL are filled in', () => {
    const shipped = parseEnv(readFileSync('.env.production.example', 'utf8'));
    const config = loadConfig({
      ...shipped,
      DATABASE_URL: 'mysql://u:p@db:3306/cadentra',
      APP_SECRET: 'x'.repeat(32),
      EMAIL_PROVIDER: 'fake',
    });
    expect(config.isProduction).toBe(true);
    expect(config.trustProxy).toBe(1);
  });
});

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
    });
    expect(config.email.provider).toBe('resend');
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
});

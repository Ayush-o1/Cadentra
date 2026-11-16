import { randomUUID } from 'node:crypto';
import type { Config } from '../config/env.js';
import type { Logger } from '../lib/logger.js';
import type { EmailProvider, OutboundEmail } from './provider.js';

/** Idempotency keys of system mail start with this, so the fake provider can tell them apart. */
export const SYSTEM_KEY_PREFIX = 'cadentra-system-';

export type SystemMailer = {
  sendPasswordReset(input: { to: string; name: string; link: string }): Promise<void>;
  sendEmailVerification(input: { to: string; name: string; link: string }): Promise<void>;
};

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function render(params: {
  to: string;
  from: string;
  subject: string;
  intro: string;
  action: string;
  link: string;
  outro: string;
}): OutboundEmail {
  const text = [params.intro, '', `${params.action}: ${params.link}`, '', params.outro].join('\n');
  const html = [
    `<p>${escapeHtml(params.intro)}</p>`,
    `<p><a href="${escapeHtml(params.link)}">${escapeHtml(params.action)}</a></p>`,
    `<p style="color:#555;font-size:12px">${escapeHtml(params.outro)}</p>`,
  ].join('\n');
  return {
    from: params.from,
    to: params.to,
    replyTo: undefined,
    subject: params.subject,
    text,
    html,
    headers: {},
  };
}

/**
 * Sends Cadentra's own transactional email (not campaigns) through the configured provider.
 * These messages carry no unsubscribe link and are never counted against a workspace's daily
 * limit: they go to someone who just asked for them.
 *
 * Failures are logged and swallowed. Callers respond to the user identically whether or not the
 * email went out, which also avoids revealing whether an address has an account.
 */
export function createSystemMailer(
  provider: EmailProvider,
  config: Config,
  logger: Logger,
): SystemMailer {
  async function deliver(email: OutboundEmail, link: string, kind: string): Promise<void> {
    try {
      await provider.send(email, `${SYSTEM_KEY_PREFIX}${randomUUID()}`);
      // With the simulated provider nothing is sent, so a developer needs the link from the log.
      // Never in production: a link in the log would be an account takeover token.
      if (provider.name === 'fake' && !config.isProduction) {
        logger.info({ kind, link }, 'Simulated system email (no real email sent)');
      }
    } catch (error) {
      logger.error({ err: error, kind }, 'Could not send system email');
    }
  }

  return {
    sendPasswordReset({ to, name, link }) {
      return deliver(
        render({
          to,
          from: config.email.systemFrom,
          subject: 'Reset your Cadentra password',
          intro: `Hi ${name}, someone asked to reset the password for this Cadentra account. If it was you, use the link below within one hour.`,
          action: 'Choose a new password',
          link,
          outro:
            'If you did not ask for this, ignore this email. Your password stays the same and the link stops working after one use.',
        }),
        link,
        'password-reset',
      );
    },
    sendEmailVerification({ to, name, link }) {
      return deliver(
        render({
          to,
          from: config.email.systemFrom,
          subject: 'Confirm your email address for Cadentra',
          intro: `Hi ${name}, confirm that this is your email address. The link works for 24 hours.`,
          action: 'Confirm email address',
          link,
          outro: 'If you did not create a Cadentra account, ignore this email.',
        }),
        link,
        'email-verification',
      );
    },
  };
}

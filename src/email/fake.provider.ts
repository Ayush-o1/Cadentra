import { randomUUID } from 'node:crypto';
import type { ProviderError } from './provider.js';
import { SYSTEM_KEY_PREFIX } from './system-mail.js';
import { type EmailProvider, type OutboundEmail, type SendResult } from './provider.js';

export type SimulatedEvent = {
  eventId: string;
  type: 'email.delivered' | 'email.bounced' | 'email.complained' | 'email.suppressed';
  providerMessageId: string;
};

type Options = {
  /** Called after a send to simulate the provider's later webhook events. */
  onEvent?: (event: SimulatedEvent) => void;
  eventDelayMs?: number;
};

/**
 * A stand-in provider for local development and tests. It sends nothing. It is selected
 * explicitly with EMAIL_PROVIDER=fake and the Settings page labels it as simulated.
 *
 * Like the real provider it honours idempotency keys, and it mimics Resend's test addresses:
 * a recipient starting with `bounced`, `complained` or `suppressed` produces that outcome,
 * anything else is delivered.
 */
export class FakeProvider implements EmailProvider {
  readonly name = 'fake' as const;
  readonly sent: { email: OutboundEmail; idempotencyKey: string; providerMessageId: string }[] = [];
  private readonly results = new Map<string, SendResult>();
  private failures: ProviderError[] = [];

  constructor(private readonly options: Options = {}) {}

  /** Makes the next sends fail with the given errors, one error per send. */
  failNext(...errors: ProviderError[]): void {
    this.failures.push(...errors);
  }

  send(email: OutboundEmail, idempotencyKey: string): Promise<SendResult> {
    const failure = this.failures.shift();
    if (failure) return Promise.reject(failure);

    const previous = this.results.get(idempotencyKey);
    if (previous) return Promise.resolve(previous);

    const result = { providerMessageId: `fake_${randomUUID()}` };
    this.results.set(idempotencyKey, result);
    this.sent.push({ email, idempotencyKey, providerMessageId: result.providerMessageId });
    // System mail (password reset, verification) is not part of any campaign: no delivery events.
    if (!idempotencyKey.startsWith(SYSTEM_KEY_PREFIX)) {
      this.simulateEvents(email.to, result.providerMessageId);
    }
    return Promise.resolve(result);
  }

  private simulateEvents(to: string, providerMessageId: string): void {
    const { onEvent, eventDelayMs = 300 } = this.options;
    if (!onEvent) return;
    const prefix = to.split('@')[0]!.split('+')[0]!.toLowerCase();
    const types: SimulatedEvent['type'][] = prefix.startsWith('bounced')
      ? ['email.bounced']
      : prefix.startsWith('suppressed')
        ? ['email.suppressed']
        : prefix.startsWith('complained')
          ? ['email.delivered', 'email.complained']
          : ['email.delivered'];
    types.forEach((type, index) => {
      setTimeout(
        () => {
          onEvent({ eventId: `fake_evt_${randomUUID()}`, type, providerMessageId });
        },
        eventDelayMs * (index + 1),
      ).unref();
    });
  }
}

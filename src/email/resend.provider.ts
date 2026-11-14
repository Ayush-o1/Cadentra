import {
  ProviderError,
  type EmailProvider,
  type OutboundEmail,
  type SendResult,
} from './provider.js';

const RESEND_API = 'https://api.resend.com';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

type ResendError = { name?: string; message?: string };

function retryAfterMs(response: Response): number | undefined {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
    : undefined;
}

/**
 * Network failures, timeouts, rate limits, server errors and idempotency-key conflicts can succeed
 * on a later attempt. Everything else (bad address, unverified domain, invalid API key, exhausted
 * quota) will fail the same way again, so it is permanent.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 409 || status >= 500;
}

export class ResendProvider implements EmailProvider {
  readonly name = 'resend' as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = RESEND_API,
  ) {}

  async send(email: OutboundEmail, idempotencyKey: string): Promise<SendResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          from: email.from,
          to: [email.to],
          subject: email.subject,
          text: email.text,
          html: email.html,
          headers: email.headers,
          ...(email.replyTo ? { reply_to: email.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      throw new ProviderError(`Could not reach Resend: ${reason}`, true);
    }

    if (response.ok) {
      const result = (await response.json().catch(() => null)) as { id?: unknown } | null;
      if (typeof result?.id !== 'string') {
        // The request was accepted but we cannot tell which message it was; retrying with the
        // same idempotency key returns the original response.
        throw new ProviderError('Resend accepted the email but returned no message id', true);
      }
      return { providerMessageId: result.id };
    }

    const detail = (await response.json().catch(() => ({}))) as ResendError;
    const message = `Resend responded ${response.status}${detail.message ? `: ${detail.message}` : ''}`;
    throw new ProviderError(message, isRetryableStatus(response.status), retryAfterMs(response));
  }
}

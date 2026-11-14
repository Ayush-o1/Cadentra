export type OutboundEmail = {
  from: string;
  to: string;
  replyTo: string | undefined;
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
};

export type SendResult = { providerMessageId: string };

/** A failure from the provider, already classified so the worker knows whether to try again. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface EmailProvider {
  readonly name: 'resend' | 'fake';
  /**
   * Sends one email. Calling this again with the same idempotency key must not send a second
   * email: the provider returns the original result instead.
   */
  send(email: OutboundEmail, idempotencyKey: string): Promise<SendResult>;
}

import { describe, expect, it, vi } from 'vitest';
import { ProviderError, type OutboundEmail } from '../../src/email/provider.js';
import { isRetryableStatus, ResendProvider } from '../../src/email/resend.provider.js';

const email: OutboundEmail = {
  from: 'Priya <priya@northwind.example>',
  to: 'ada@example.org',
  replyTo: 'help@northwind.example',
  subject: 'Hello',
  text: 'Hi',
  html: '<p>Hi</p>',
  headers: { 'List-Unsubscribe': '<https://app.example.org/u/1.x>' },
};

function providerWith(response: Response | Error) {
  const fetchMock = vi.fn(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
  return {
    provider: new ResendProvider('re_test_key', fetchMock, 'https://api.test'),
    fetchMock,
  };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

async function failureOf(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    return error as ProviderError;
  }
  throw new Error('expected the send to fail');
}

describe('ResendProvider', () => {
  it('posts the email with the API key and idempotency key', async () => {
    const { provider, fetchMock } = providerWith(json({ id: 're_msg_1' }, { status: 200 }));
    const result = await provider.send(email, 'cadentra-message-9');
    expect(result).toEqual({ providerMessageId: 're_msg_1' });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/emails');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer re_test_key');
    expect(headers['Idempotency-Key']).toBe('cadentra-message-9');
    expect(JSON.parse(init.body as string)).toEqual({
      from: email.from,
      to: ['ada@example.org'],
      subject: 'Hello',
      text: 'Hi',
      html: '<p>Hi</p>',
      headers: email.headers,
      reply_to: 'help@northwind.example',
    });
  });

  it('treats a rate limit as retryable and passes on Retry-After', async () => {
    const { provider } = providerWith(
      json({ message: 'Too many requests' }, { status: 429, headers: { 'retry-after': '30' } }),
    );
    const error = await failureOf(provider.send(email, 'k'));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(30_000);
  });

  it('treats server errors and network failures as retryable', async () => {
    const serverError = await failureOf(
      providerWith(json({}, { status: 503 })).provider.send(email, 'k'),
    );
    expect(serverError.retryable).toBe(true);
    const network = await failureOf(
      providerWith(new TypeError('fetch failed')).provider.send(email, 'k'),
    );
    expect(network.retryable).toBe(true);
    expect(network.message).toMatch(/Could not reach Resend/);
  });

  it('treats client errors as permanent and keeps the provider message', async () => {
    const error = await failureOf(
      providerWith(
        json({ name: 'validation_error', message: 'Invalid `to` field' }, { status: 422 }),
      ).provider.send(email, 'k'),
    );
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('422');
    expect(error.message).toContain('Invalid `to` field');
  });

  it('retries when the API accepts the request but returns no id', async () => {
    const error = await failureOf(
      providerWith(json({}, { status: 200 })).provider.send(email, 'k'),
    );
    expect(error.retryable).toBe(true);
  });

  it('omits reply_to when there is none', async () => {
    const { provider, fetchMock } = providerWith(json({ id: 'x' }));
    await provider.send({ ...email, replyTo: undefined }, 'k');
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('reply_to');
  });
});

describe('isRetryableStatus', () => {
  it.each([
    [400, false],
    [401, false],
    [403, false],
    [404, false],
    [422, false],
    [409, true],
    [429, true],
    [500, true],
    [502, true],
    [503, true],
  ])('status %i is retryable: %s', (status, expected) => {
    expect(isRetryableStatus(status)).toBe(expected);
  });
});

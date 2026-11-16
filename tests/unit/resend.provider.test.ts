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

  it('treats a bad key or unverified domain as permanent', async () => {
    for (const [status, name] of [
      [401, 'restricted_api_key'],
      [403, 'validation_error'],
    ] as const) {
      const error = await failureOf(
        providerWith(json({ name, message: 'nope' }, { status })).provider.send(email, 'k'),
      );
      expect(error.retryable, `${status} ${name}`).toBe(false);
      expect(error.quota).toBe(false);
    }
  });

  it('waits until the daily quota resets without blaming the message', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-17T20:30:00Z'), toFake: ['Date'] });
    try {
      const error = await failureOf(
        providerWith(
          json({ name: 'daily_quota_exceeded', message: 'quota' }, { status: 429 }),
        ).provider.send(email, 'k'),
      );
      expect(error).toMatchObject({ retryable: true, quota: true });
      // 3.5 hours to midnight UTC plus a minute of slack.
      expect(error.retryAfterMs).toBe(3.5 * 3_600_000 + 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits hours for a monthly quota', async () => {
    const error = await failureOf(
      providerWith(
        json({ name: 'monthly_quota_exceeded', message: 'quota' }, { status: 429 }),
      ).provider.send(email, 'k'),
    );
    expect(error).toMatchObject({ retryable: true, quota: true, retryAfterMs: 6 * 3_600_000 });
  });

  it('does not retry an idempotency-key conflict that could duplicate a sent email', async () => {
    const error = await failureOf(
      providerWith(
        json({ name: 'invalid_idempotent_request', message: 'body modified' }, { status: 409 }),
      ).provider.send(email, 'k'),
    );
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('check the Resend logs');
  });

  it('retries while another request holds the same idempotency key', async () => {
    const error = await failureOf(
      providerWith(
        json({ name: 'concurrent_idempotent_requests', message: 'busy' }, { status: 409 }),
      ).provider.send(email, 'k'),
    );
    expect(error.retryable).toBe(true);
    expect(error.quota).toBe(false);
  });

  it('retries a timeout and survives a non-JSON error body', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    expect((await failureOf(providerWith(timeout).provider.send(email, 'k'))).retryable).toBe(true);
    const html = await failureOf(
      providerWith(new Response('<html>Bad gateway</html>', { status: 502 })).provider.send(
        email,
        'k',
      ),
    );
    expect(html.retryable).toBe(true);
    expect(html.message).toContain('502');
  });

  it('never puts the API key in an error message', async () => {
    const { provider } = providerWith(json({ message: 'bad' }, { status: 401 }));
    const error = await failureOf(provider.send(email, 'k'));
    expect(error.message).not.toContain('re_test_key');
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

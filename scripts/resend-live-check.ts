/**
 * One-off live check of the Resend integration. It sends a handful of emails to Resend's own
 * test addresses (resend.dev) so no real person is ever contacted, and checks the behaviours the
 * automated tests can only simulate: a real send, idempotent retry, and the conflict error.
 *
 *   RESEND_API_KEY=re_… RESEND_LIVE_TEST_CONFIRM=send-test-emails npm run resend:live
 *
 * It refuses to run without the confirmation variable. It reads the key from the environment and
 * never prints it. Optional: RESEND_LIVE_FROM (default `Cadentra Test <onboarding@resend.dev>`).
 * Use an address on your verified domain once you have one.
 *
 * Emails sent: 3 (delivered, bounced, complained test addresses). The idempotent repeat and the
 * conflict probe send nothing. Test emails count toward your Resend quota.
 */
import { randomBytes } from 'node:crypto';
import { ProviderError, type OutboundEmail } from '../src/email/provider.js';
import { ResendProvider } from '../src/email/resend.provider.js';

const apiKey = process.env['RESEND_API_KEY'];
if (!apiKey) {
  console.error('Set RESEND_API_KEY in your shell (not in a file that is committed).');
  process.exit(2);
}
if (process.env['RESEND_LIVE_TEST_CONFIRM'] !== 'send-test-emails') {
  console.error(
    'Refusing to send. This script sends 3 emails through your Resend account (to resend.dev test\n' +
      'addresses only). To proceed, set RESEND_LIVE_TEST_CONFIRM=send-test-emails.',
  );
  process.exit(2);
}

const from = process.env['RESEND_LIVE_FROM'] ?? 'Cadentra Test <onboarding@resend.dev>';
const run = randomBytes(4).toString('hex');
const provider = new ResendProvider(apiKey);

const SAFE_RECIPIENTS = [
  `delivered+cadentra-${run}@resend.dev`,
  `bounced+cadentra-${run}@resend.dev`,
  `complained+cadentra-${run}@resend.dev`,
] as const;

const emailFor = (to: string, body: string): OutboundEmail => ({
  from,
  to,
  replyTo: undefined,
  subject: `Cadentra live check ${run}`,
  text: `${body}\n\nSent by scripts/resend-live-check.ts`,
  html: `<p>${body}</p><p>Sent by scripts/resend-live-check.ts</p>`,
  headers: {},
});

let failures = 0;
const pass = (message: string) => console.log(`  ok    ${message}`);
const fail = (message: string) => {
  failures += 1;
  console.log(`  FAIL  ${message}`);
};

function describeError(error: unknown): string {
  return error instanceof ProviderError
    ? `${error.message} (retryable=${error.retryable}${error.options.code ? `, code=${error.options.code}` : ''})`
    : String(error);
}

console.log(`Resend live check ${run}, sending as ${from}\n`);

const ids: string[] = [];
for (const [index, to] of SAFE_RECIPIENTS.entries()) {
  const key = `cadentra-live-check-${run}-${index}`;
  try {
    const { providerMessageId } = await provider.send(emailFor(to, `Hello ${index}`), key);
    ids.push(providerMessageId);
    pass(`sent to ${to.split('+')[0]}@resend.dev, provider id ${providerMessageId}`);
  } catch (error) {
    fail(`send to ${to}: ${describeError(error)}`);
    if (error instanceof ProviderError && !error.retryable) {
      console.log(
        '        A permanent error on the first send usually means the key is wrong or the from\n' +
          '        address is not allowed (unverified domain). See docs/FINAL_MANUAL_SETUP.md.',
      );
      break;
    }
  }
}

if (ids[0]) {
  const key = `cadentra-live-check-${run}-0`;
  try {
    const again = await provider.send(emailFor(SAFE_RECIPIENTS[0], 'Hello 0'), key);
    if (again.providerMessageId === ids[0]) {
      pass('repeating the same idempotency key returned the original id (no second email)');
    } else {
      fail(`repeat returned a different id ${again.providerMessageId}: DUPLICATE RISK`);
    }
  } catch (error) {
    fail(`idempotent repeat: ${describeError(error)}`);
  }

  try {
    await provider.send(emailFor(SAFE_RECIPIENTS[0], 'A different body'), key);
    fail('same key with a different body was accepted; expected a 409 conflict');
  } catch (error) {
    if (error instanceof ProviderError && error.options.code === 'invalid_idempotent_request') {
      pass('same key with a changed body is rejected as a permanent conflict');
    } else {
      fail(`conflict probe: ${describeError(error)}`);
    }
  }
}

console.log(
  `\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}\n` +
    'Next: in the Resend dashboard (Emails and Webhooks) confirm delivered, bounced and complained\n' +
    'events appear, and that your deployed app received them (see docs/FINAL_MANUAL_SETUP.md).',
);
process.exit(failures === 0 ? 0 : 1);

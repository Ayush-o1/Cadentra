import { describe, expect, it } from 'vitest';
import {
  createUnsubscribeToken,
  readUnsubscribeToken,
} from '../../src/modules/unsubscribe/unsubscribe.token.js';

const secret = 's'.repeat(40);

describe('unsubscribe tokens', () => {
  it('round-trips the message id', () => {
    expect(readUnsubscribeToken(secret, createUnsubscribeToken(secret, 4821))).toBe(4821);
  });

  it('rejects a token signed with another secret', () => {
    expect(readUnsubscribeToken('x'.repeat(40), createUnsubscribeToken(secret, 7))).toBeNull();
  });

  it('rejects a token whose id was changed', () => {
    const token = createUnsubscribeToken(secret, 7);
    expect(readUnsubscribeToken(secret, token.replace(/^7\./, '8.'))).toBeNull();
  });

  it('rejects malformed input', () => {
    for (const bad of [
      '',
      'abc',
      '7',
      '7.',
      '.sig',
      '7.a.b',
      '-1.sig',
      'x.sig',
      '99999999999.sig',
    ]) {
      expect(readUnsubscribeToken(secret, bad), bad).toBeNull();
    }
  });
});

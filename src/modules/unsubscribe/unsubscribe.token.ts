import { safeEqual, signValue } from '../../lib/crypto.js';

/** `<messageId>.<signature>`. The signature stops anyone from unsubscribing arbitrary messages. */
export function createUnsubscribeToken(secret: string, messageId: number): string {
  return `${messageId}.${signValue(secret, `unsubscribe:${messageId}`)}`;
}

export function readUnsubscribeToken(secret: string, token: string): number | null {
  const [id, signature, ...rest] = token.split('.');
  if (!id || !signature || rest.length > 0 || !/^\d{1,10}$/.test(id)) return null;
  const messageId = Number(id);
  return safeEqual(signature, signValue(secret, `unsubscribe:${messageId}`)) ? messageId : null;
}

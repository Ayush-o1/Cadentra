import { describe, expect, it } from 'vitest';
import { isContentionError } from '../../src/worker/claim.js';

describe('isContentionError', () => {
  it.each([
    'Raw query failed. Code: `1213`. Message: `Deadlock found when trying to get lock`',
    'Raw query failed. Code: `1205`. Message: `Lock wait timeout exceeded`',
    'Raw query failed. Code: `9007`. Message: `Write conflict, txnStartTS=1, conflictStartTS=2`',
    'Error 8022: Error: KV error safe to retry',
  ])('treats %s as losing a race', (message) => {
    expect(isContentionError(new Error(message))).toBe(true);
  });

  it.each([
    'Raw query failed. Code: `1146`. Message: `Table does not exist`',
    'Connection refused',
    'Raw query failed. Code: `1064`. Message: `You have an error in your SQL syntax`',
  ])('does not hide real failures such as %s', (message) => {
    expect(isContentionError(new Error(message))).toBe(false);
    expect(isContentionError('weird')).toBe(false);
  });
});

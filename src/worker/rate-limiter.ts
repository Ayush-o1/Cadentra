const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Spaces calls at least 1/perSecond apart, however many workers ask at once. */
export function createSendThrottle(perSecond: number) {
  const intervalMs = 1000 / perSecond;
  let nextSlot = 0;
  return async function acquire(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + intervalMs;
    if (slot > now) await sleep(slot - now);
  };
}

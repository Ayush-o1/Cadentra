import { describe, expect, it } from 'vitest';
import { assessCampaignHealth, HEALTH_LIMITS } from '../../src/worker/health.js';

describe('assessCampaignHealth', () => {
  it('never pauses on a sample too small to mean anything', () => {
    expect(assessCampaignHealth({ accepted: 19, bounced: 19, complained: 5 })).toEqual({
      pause: false,
    });
  });

  it('pauses when the bounce rate reaches the limit', () => {
    const verdict = assessCampaignHealth({ accepted: 40, bounced: 2, complained: 0 });
    expect(verdict.pause).toBe(true);
    expect(verdict.pause && verdict.reason).toMatch(/bounce rate 5\.0%/);
  });

  it('stays running just under the limit', () => {
    expect(assessCampaignHealth({ accepted: 100, bounced: 2, complained: 0 })).toEqual({
      pause: false,
    });
    expect(assessCampaignHealth({ accepted: 100, bounced: 3, complained: 0 }).pause).toBe(true);
  });

  it('pauses on complaints at the provider-safe rate', () => {
    const accepted = Math.ceil(1 / HEALTH_LIMITS.maxComplaintRate) + 1;
    expect(assessCampaignHealth({ accepted, bounced: 0, complained: 1 })).toEqual({ pause: false });
    const verdict = assessCampaignHealth({ accepted: 500, bounced: 0, complained: 1 });
    expect(verdict.pause && verdict.reason).toMatch(/complaint rate/);
  });

  it('keeps its limits comfortably below the provider shutdown thresholds', () => {
    expect(HEALTH_LIMITS.maxBounceRate).toBeLessThan(0.04);
    expect(HEALTH_LIMITS.maxComplaintRate).toBeLessThanOrEqual(0.0008);
  });
});

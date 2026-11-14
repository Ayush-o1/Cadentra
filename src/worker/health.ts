/**
 * Resend can shut an account down above 4% bounces or 0.08% complaints. Campaigns are paused well
 * before that, once there are enough sends for the rates to mean something.
 */
export const HEALTH_LIMITS = {
  minSample: 20,
  maxBounceRate: 0.03,
  maxComplaintRate: 0.0008,
} as const;

export type DeliveryStats = { accepted: number; bounced: number; complained: number };

export type HealthVerdict = { pause: false } | { pause: true; reason: string };

const percent = (rate: number) => `${(rate * 100).toFixed(rate < 0.01 ? 2 : 1)}%`;

export function assessCampaignHealth(stats: DeliveryStats): HealthVerdict {
  if (stats.accepted < HEALTH_LIMITS.minSample) return { pause: false };

  const bounceRate = stats.bounced / stats.accepted;
  if (bounceRate >= HEALTH_LIMITS.maxBounceRate) {
    return {
      pause: true,
      reason: `bounce rate ${percent(bounceRate)} reached the ${percent(HEALTH_LIMITS.maxBounceRate)} limit`,
    };
  }
  const complaintRate = stats.complained / stats.accepted;
  if (complaintRate >= HEALTH_LIMITS.maxComplaintRate) {
    return {
      pause: true,
      reason: `complaint rate ${percent(complaintRate)} reached the ${percent(HEALTH_LIMITS.maxComplaintRate)} limit`,
    };
  }
  return { pause: false };
}

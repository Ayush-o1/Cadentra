import { HEALTH_LIMITS } from '../../worker/health.js';

export type DeliveryCounts = {
  /** Messages the provider accepted. */
  accepted: number;
  /** Delivered to the recipient's mail server. A message later reported as spam was delivered first. */
  delivered: number;
  bounced: number;
  complained: number;
  /** Accepted, with no delivery result from the provider yet. */
  awaiting: number;
  /** Never accepted: the provider refused it or retries ran out. */
  failed: number;
};

export type DeliveryRates = {
  delivery: number | null;
  bounce: number | null;
  complaint: number | null;
};

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/** Rates are measured against accepted messages, and are null rather than 0% when nothing was sent. */
export function computeRates(counts: DeliveryCounts): DeliveryRates {
  return {
    delivery: ratio(counts.delivered, counts.accepted),
    bounce: ratio(counts.bounced, counts.accepted),
    complaint: ratio(counts.complained, counts.accepted),
  };
}

export const RATE_LIMITS = {
  pauseBounce: HEALTH_LIMITS.maxBounceRate,
  pauseComplaint: HEALTH_LIMITS.maxComplaintRate,
  providerBounce: 0.04,
  providerComplaint: 0.0008,
} as const;

export type SeriesPoint = {
  date: string;
  accepted: number;
  delivered: number;
  bounced: number;
  complained: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** One point per UTC day in [from, to), with zeros where nothing was sent, so charts have no gaps. */
export function fillSeries(from: Date, to: Date, rows: SeriesPoint[]): SeriesPoint[] {
  const byDay = new Map(rows.map((row) => [row.date, row]));
  const points: SeriesPoint[] = [];
  for (
    let time = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    time < to.getTime();
    time += DAY_MS
  ) {
    const date = isoDay(new Date(time));
    points.push(byDay.get(date) ?? { date, accepted: 0, delivered: 0, bounced: 0, complained: 0 });
  }
  return points;
}

export type RangeInput = {
  range: '7d' | '30d' | '90d';
  from?: Date | undefined;
  to?: Date | undefined;
};

/** The reporting window: a preset ending now, or explicit dates, capped at one year. */
export function resolveRange(input: RangeInput, now: Date): { from: Date; to: Date } {
  if (input.from && input.to) return { from: input.from, to: input.to };
  const days = { '7d': 7, '30d': 30, '90d': 90 }[input.range];
  const to = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS + DAY_MS);
  return { from: new Date(to.getTime() - days * DAY_MS), to };
}

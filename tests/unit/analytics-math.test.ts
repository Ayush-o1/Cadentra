import { describe, expect, it } from 'vitest';
import {
  computeRates,
  fillSeries,
  resolveRange,
  type DeliveryCounts,
} from '../../src/modules/analytics/analytics.math.js';

const counts = (overrides: Partial<DeliveryCounts> = {}): DeliveryCounts => ({
  accepted: 0,
  delivered: 0,
  bounced: 0,
  complained: 0,
  awaiting: 0,
  failed: 0,
  ...overrides,
});

describe('computeRates', () => {
  it('reports no rates, not 0%, when nothing was sent', () => {
    expect(computeRates(counts())).toEqual({ delivery: null, bounce: null, complaint: null });
  });

  it('measures every rate against accepted messages', () => {
    const rates = computeRates(
      counts({ accepted: 200, delivered: 180, bounced: 6, complained: 1, awaiting: 13 }),
    );
    expect(rates.delivery).toBeCloseTo(0.9);
    expect(rates.bounce).toBeCloseTo(0.03);
    expect(rates.complaint).toBeCloseTo(0.005);
  });

  it('does not count messages that never reached the provider', () => {
    expect(computeRates(counts({ accepted: 10, delivered: 10, failed: 90 })).delivery).toBe(1);
  });
});

describe('fillSeries', () => {
  const point = (date: string, accepted: number) => ({
    date,
    accepted,
    delivered: accepted,
    bounced: 0,
    complained: 0,
  });

  it('returns one point per UTC day and zero-fills the gaps', () => {
    const series = fillSeries(new Date('2026-11-10T00:00:00Z'), new Date('2026-11-14T00:00:00Z'), [
      point('2026-11-11', 4),
      point('2026-11-13', 2),
    ]);
    expect(series.map((p) => [p.date, p.accepted])).toEqual([
      ['2026-11-10', 0],
      ['2026-11-11', 4],
      ['2026-11-12', 0],
      ['2026-11-13', 2],
    ]);
  });

  it('includes the day that the range ends part-way through', () => {
    const series = fillSeries(
      new Date('2026-11-10T00:00:00Z'),
      new Date('2026-11-12T06:00:00Z'),
      [],
    );
    expect(series.map((p) => p.date)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
  });
});

describe('resolveRange', () => {
  const now = new Date('2026-11-14T15:30:00Z');

  it('ends tomorrow at midnight UTC so today is included', () => {
    const { from, to } = resolveRange({ range: '7d' }, now);
    expect(to.toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(from.toISOString()).toBe('2026-11-08T00:00:00.000Z');
  });

  it('prefers explicit dates over the preset', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z');
    expect(resolveRange({ range: '30d', from, to }, now)).toEqual({ from, to });
  });
});

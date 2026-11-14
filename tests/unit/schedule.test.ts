import { describe, expect, it } from 'vitest';
import { computeRunAt, nextAllowedTime, type SendWindow } from '../../src/worker/schedule.js';

const iso = (value: string) => new Date(value);
const businessHours = (timeZone: string, weekdaysOnly = true): SendWindow => ({
  startHour: 9,
  endHour: 17,
  weekdaysOnly,
  timeZone,
});

describe('nextAllowedTime', () => {
  it('keeps a moment that is already inside the window', () => {
    const from = iso('2026-11-17T10:30:00Z'); // Tuesday 10:30 UTC
    expect(nextAllowedTime(from, businessHours('UTC'))).toEqual(from);
  });

  it('waits for the window to open when it is too early', () => {
    expect(nextAllowedTime(iso('2026-11-17T06:15:00Z'), businessHours('UTC'))).toEqual(
      iso('2026-11-17T09:00:00Z'),
    );
  });

  it('moves to the next morning when the window has closed', () => {
    expect(nextAllowedTime(iso('2026-11-17T17:00:00Z'), businessHours('UTC'))).toEqual(
      iso('2026-11-18T09:00:00Z'),
    );
  });

  it('skips the weekend', () => {
    // Friday 18:00 UTC -> Monday 09:00 UTC
    expect(nextAllowedTime(iso('2026-11-20T18:00:00Z'), businessHours('UTC'))).toEqual(
      iso('2026-11-23T09:00:00Z'),
    );
    // Saturday midday
    expect(nextAllowedTime(iso('2026-11-21T12:00:00Z'), businessHours('UTC'))).toEqual(
      iso('2026-11-23T09:00:00Z'),
    );
  });

  it('sends on weekends when weekdays-only is off', () => {
    const saturday = iso('2026-11-21T12:00:00Z');
    expect(nextAllowedTime(saturday, businessHours('UTC', false))).toEqual(saturday);
  });

  it('supports a window that runs to midnight', () => {
    const window: SendWindow = { startHour: 0, endHour: 24, weekdaysOnly: false, timeZone: 'UTC' };
    const from = iso('2026-11-17T23:59:00Z');
    expect(nextAllowedTime(from, window)).toEqual(from);
  });

  it('evaluates the window in the workspace time zone', () => {
    // 2026-11-17 14:00 UTC is 09:00 in New York (EST, UTC-5): inside the window.
    expect(nextAllowedTime(iso('2026-11-17T14:00:00Z'), businessHours('America/New_York'))).toEqual(
      iso('2026-11-17T14:00:00Z'),
    );
    // 13:00 UTC is 08:00 in New York: wait one hour.
    expect(nextAllowedTime(iso('2026-11-17T13:00:00Z'), businessHours('America/New_York'))).toEqual(
      iso('2026-11-17T14:00:00Z'),
    );
  });

  it('handles zones with a half-hour offset', () => {
    // Kolkata is UTC+5:30. 09:00 IST is 03:30 UTC.
    expect(nextAllowedTime(iso('2026-11-17T01:00:00Z'), businessHours('Asia/Kolkata'))).toEqual(
      iso('2026-11-17T03:30:00Z'),
    );
  });

  it('uses the correct offset on either side of a daylight-saving change', () => {
    // London springs forward on 2026-03-29. Saturday 28 March is before the change (GMT),
    // Monday 30 March is after it (BST, UTC+1). Both 09:00 openings are expressed in UTC.
    const london = businessHours('Europe/London');
    expect(nextAllowedTime(iso('2026-03-27T18:00:00Z'), london)).toEqual(
      iso('2026-03-30T08:00:00Z'),
    );
    expect(nextAllowedTime(iso('2026-03-26T18:00:00Z'), london)).toEqual(
      iso('2026-03-27T09:00:00Z'),
    );
  });

  it('handles the autumn change in New York', () => {
    // US clocks fall back on 2026-11-01. Monday 2 November 09:00 is EST (UTC-5) = 14:00 UTC.
    expect(nextAllowedTime(iso('2026-10-31T23:00:00Z'), businessHours('America/New_York'))).toEqual(
      iso('2026-11-02T14:00:00Z'),
    );
  });
});

describe('computeRunAt', () => {
  it('keeps seconds and milliseconds so a delay is exact', () => {
    const base = iso('2026-11-17T10:00:37.482Z');
    expect(computeRunAt(base, 3, businessHours('UTC'))).toEqual(iso('2026-11-20T10:00:37.482Z'));
    expect(computeRunAt(base, 3, businessHours('Asia/Kolkata'))).toEqual(
      iso('2026-11-20T10:00:37.482Z'),
    );
  });

  it('adds calendar days and keeps the local time of day', () => {
    const base = iso('2026-11-17T10:00:00Z'); // Tuesday
    expect(computeRunAt(base, 2, businessHours('UTC'))).toEqual(iso('2026-11-19T10:00:00Z'));
  });

  it('does not add a delay for zero days', () => {
    const base = iso('2026-11-17T10:00:00Z');
    expect(computeRunAt(base, 0, businessHours('UTC'))).toEqual(base);
  });

  it('pushes a Saturday target to Monday morning', () => {
    const base = iso('2026-11-19T10:00:00Z'); // Thursday
    expect(computeRunAt(base, 2, businessHours('UTC'))).toEqual(iso('2026-11-23T09:00:00Z'));
  });

  it('keeps the same wall-clock hour across a daylight-saving change', () => {
    // Friday 27 March 10:00 London (GMT) plus 7 days = Friday 3 April 10:00 London (BST) = 09:00 UTC.
    const base = iso('2026-03-27T10:00:00Z');
    expect(computeRunAt(base, 7, businessHours('Europe/London'))).toEqual(
      iso('2026-04-03T09:00:00Z'),
    );
  });

  it('moves a target that lands after closing time to the next opening', () => {
    const base = iso('2026-11-17T16:30:00Z');
    expect(computeRunAt(base, 1, businessHours('UTC'))).toEqual(iso('2026-11-18T16:30:00Z'));
    expect(
      computeRunAt(iso('2026-11-17T16:59:00Z'), 0, { ...businessHours('UTC'), endHour: 16 }),
    ).toEqual(iso('2026-11-18T09:00:00Z'));
  });
});

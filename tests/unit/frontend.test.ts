import { describe, expect, it } from 'vitest';
import { hourLabel, summarize, windowSentence } from '../../src/public/js/campaign-utils.js';
import {
  consentChange,
  csvCell,
  describeActivity,
  formatPercent,
  fullName,
  initials,
} from '../../src/public/js/format.js';
import { latestOnly } from '../../src/public/js/dom.js';
import { defineRoutes, resolve } from '../../src/public/js/router.js';

describe('formatPercent', () => {
  it('shows a dash, not 0%, when there is nothing to measure', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(undefined)).toBe('—');
  });

  it('keeps one decimal for small rates and rounds larger ones', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.0361)).toBe('3.6%');
    expect(formatPercent(0.03)).toBe('3%');
    expect(formatPercent(0.8123)).toBe('81%');
    expect(formatPercent(1)).toBe('100%');
  });
});

describe('small formatters', () => {
  it('builds initials and names', () => {
    expect(initials('Priya Raman')).toBe('PR');
    expect(initials('  cher  ')).toBe('C');
    expect(fullName({ firstName: 'Ada', lastName: 'Lovelace' })).toBe('Ada Lovelace');
    expect(fullName({ firstName: null, lastName: 'Rossi' })).toBe('Rossi');
  });

  it('quotes CSV cells so a downloaded report opens correctly', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell(null)).toBe('""');
  });

  it('neutralises spreadsheet formulas in exported cells', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1 555')).toBe('"\'+1 555"');
    expect(csvCell('-2')).toBe('"\'-2"');
    expect(csvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
    expect(csvCell('safe-text')).toBe('"safe-text"');
  });

  it('describes activity in plain words', () => {
    expect(
      describeActivity({
        action: 'campaign.launched',
        actor: 'Priya',
        metadata: { recipients: 12 },
      }),
    ).toBe('Priya launched a campaign to 12 people');
    expect(
      describeActivity({
        action: 'contact.unsubscribed',
        actor: null,
        metadata: { email: 'a@b.example' },
      }),
    ).toBe('a@b.example unsubscribed');
    expect(describeActivity({ action: 'something.new', actor: 'X', metadata: null })).toBe(
      'something.new',
    );
  });
});

describe('campaign helpers', () => {
  const counts = {
    scheduled: 5,
    sending: 1,
    accepted: 2,
    delivered: 10,
    bounced: 1,
    complained: 1,
    failed: 3,
    skipped: 4,
    cancelled: 0,
  };

  it('derives sent, delivered and waiting from per-status counts', () => {
    expect(summarize(counts)).toEqual({
      sent: 14,
      delivered: 11,
      bounced: 1,
      complained: 1,
      awaiting: 2,
      waiting: 6,
      failed: 3,
      skipped: 4,
    });
  });

  it('labels hours, including the end of the day', () => {
    expect(hourLabel(9)).toBe('09:00');
    expect(hourLabel(24)).toBe('24:00');
  });

  it('describes the sending window in words', () => {
    const sentence = windowSentence(
      { windowStartHour: 9, windowEndHour: 17, weekdaysOnly: true },
      'Europe/London',
    );
    expect(sentence).toBe('Between 09:00 and 17:00 on weekdays, Europe/London time.');
  });
});

describe('router', () => {
  defineRoutes([
    { path: '/', page: () => null },
    { path: '/campaigns', page: () => null },
    { path: '/campaigns/:id', page: () => null },
    { path: '/campaigns/:id/edit', page: () => null },
    { path: '/u/:token', page: () => null },
  ]);

  it('matches static and parameterised paths', () => {
    expect(resolve('/')?.params).toEqual({});
    expect(resolve('/campaigns')).toMatchObject({ route: { path: '/campaigns' } });
    expect(resolve('/campaigns/42')?.params).toEqual({ id: '42' });
    expect(resolve('/campaigns/42/edit')?.params).toEqual({ id: '42' });
    expect(resolve('/campaigns/42/')?.params).toEqual({ id: '42' });
  });

  it('decodes parameters and rejects unknown paths', () => {
    expect(resolve('/u/12.abc%2Bdef')?.params).toEqual({ token: '12.abc+def' });
    expect(resolve('/campaigns/42/edit/extra')).toBeNull();
    expect(resolve('/nope')).toBeNull();
  });
});

describe('consentChange', () => {
  const original = '2026-11-16T06:40:00.000Z';

  it('sends nothing when the date was not touched, so unrelated edits cannot fail', () => {
    expect(consentChange(original, '2026-11-16', new Date('2026-11-16T06:45:00Z'))).toBeUndefined();
    expect(consentChange(original, '', new Date())).toBeUndefined();
  });

  it('never sends a time in the future, even for today before noon UTC', () => {
    const now = new Date('2026-11-16T06:45:00Z');
    const sent = consentChange('2026-11-10T09:00:00.000Z', '2026-11-16', now);
    expect(new Date(sent!).getTime()).toBeLessThanOrEqual(now.getTime());
  });

  it('uses noon UTC for an earlier day', () => {
    expect(consentChange(original, '2026-11-01', new Date('2026-11-16T06:45:00Z'))).toBe(
      '2026-11-01T12:00:00.000Z',
    );
  });
});

describe('latestOnly', () => {
  it('lets only the newest request apply its result', () => {
    const begin = latestOnly();
    const first = begin();
    expect(first()).toBe(true);
    const second = begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});

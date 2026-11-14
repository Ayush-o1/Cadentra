export type SendWindow = {
  startHour: number;
  endHour: number;
  weekdaysOnly: boolean;
  timeZone: string;
};

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function localParts(instant: Date, timeZone: string): LocalParts {
  const values: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values['year']!,
    month: values['month']!,
    day: values['day']!,
    hour: values['hour']!,
    minute: values['minute']!,
    second: values['second']!,
  };
}

/** How far the zone's wall clock is ahead of UTC at this instant, in milliseconds. */
function offsetAt(instant: Date, timeZone: string): number {
  const local = localParts(instant, timeZone);
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Converts a wall-clock time in a zone to the instant it happens. The offset is evaluated twice
 * so times that sit next to a daylight-saving change resolve to the correct side of it.
 */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const firstGuess = naive - offsetAt(new Date(naive), timeZone);
  return new Date(naive - offsetAt(new Date(firstGuess), timeZone));
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isAllowedDay(window: SendWindow, year: number, month: number, day: number): boolean {
  if (!window.weekdaysOnly) return true;
  const weekday = weekdayOf(year, month, day);
  return weekday >= 1 && weekday <= 5;
}

function addCalendarDays(year: number, month: number, day: number, days: number) {
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** The earliest moment at or after `from` that lies inside the sending window. */
export function nextAllowedTime(from: Date, window: SendWindow): Date {
  const local = localParts(from, window.timeZone);
  const today = isAllowedDay(window, local.year, local.month, local.day);

  if (today && local.hour >= window.startHour && local.hour < window.endHour) return from;

  const startsLaterToday = today && local.hour < window.startHour;
  for (let offset = startsLaterToday ? 0 : 1; offset <= 8; offset++) {
    const date = addCalendarDays(local.year, local.month, local.day, offset);
    if (isAllowedDay(window, date.year, date.month, date.day)) {
      return zonedTimeToUtc(date.year, date.month, date.day, window.startHour, 0, window.timeZone);
    }
  }
  throw new Error('No allowed sending day found');
}

/**
 * When the next step of a sequence should go out: `delayDays` calendar days after `base`, at the
 * same local time of day, moved forward into the sending window if it falls outside it.
 */
export function computeRunAt(base: Date, delayDays: number, window: SendWindow): Date {
  if (delayDays === 0) return nextAllowedTime(base, window);
  const local = localParts(base, window.timeZone);
  const date = addCalendarDays(local.year, local.month, local.day, delayDays);
  const target = zonedTimeToUtc(
    date.year,
    date.month,
    date.day,
    local.hour,
    local.minute,
    window.timeZone,
  );
  return nextAllowedTime(target, window);
}

/** Turns per-status message counts into the numbers people care about. */
export function summarize(counts) {
  const sent = counts.accepted + counts.delivered + counts.bounced + counts.complained;
  return {
    sent,
    delivered: counts.delivered + counts.complained,
    bounced: counts.bounced,
    complained: counts.complained,
    awaiting: counts.accepted,
    waiting: counts.scheduled + counts.sending,
    failed: counts.failed,
    skipped: counts.skipped,
  };
}

export const hourLabel = (hour) => `${String(hour).padStart(2, '0')}:00`;

export function windowSentence(campaign, timezone) {
  const days = campaign.weekdaysOnly ? 'on weekdays' : 'every day';
  return `Between ${hourLabel(campaign.windowStartHour)} and ${hourLabel(campaign.windowEndHour)} ${days}, ${timezone} time.`;
}

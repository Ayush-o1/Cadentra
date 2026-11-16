const dateFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
});
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const numberFormat = new Intl.NumberFormat();

export const formatNumber = (value) => numberFormat.format(value ?? 0);
export const formatDate = (value) => (value ? dateFormat.format(new Date(value)) : '—');
export const formatDateTime = (value) => (value ? dateTimeFormat.format(new Date(value)) : '—');

export function formatRelative(value) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const steps = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

/** Rates are null when nothing was sent. Show a dash rather than a misleading 0%. */
export function formatPercent(rate) {
  if (rate === null || rate === undefined) return '—';
  const percent = rate * 100;
  if (percent === 0) return '0%';
  return `${percent < 10 && percent !== Math.round(percent) ? percent.toFixed(1) : Math.round(percent)}%`;
}

export const initials = (name) =>
  (name ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

/**
 * The consent timestamp to send when a contact is edited, or undefined when the date was not
 * changed (so an unrelated edit never touches it). The form only has a date, so a changed date is
 * sent as noon UTC, but never later than now: sending noon for today before noon UTC was rejected
 * by the server as "dated in the future", which made any edit of a same-day contact fail in the
 * morning (found because CI ran before noon UTC).
 */
export function consentChange(originalIso, dateValue, now = new Date()) {
  if (!dateValue || dateValue === originalIso.slice(0, 10)) return undefined;
  const chosen = new Date(`${dateValue}T12:00:00Z`);
  return (chosen.getTime() > now.getTime() ? now : chosen).toISOString();
}

export const CONSENT_LABELS = {
  requested_contact: 'Asked us to get in touch',
  existing_customer: 'Existing customer',
  signed_up: 'Signed up',
  event_attendee: 'Event attendee',
  other_documented: 'Other, documented',
};

export const SUPPRESSION_LABELS = {
  unsubscribed: 'Unsubscribed',
  hard_bounce: 'Bounced',
  complaint: 'Marked as spam',
  manual: 'Blocked by you',
};

export const CAMPAIGN_STATUS = {
  draft: { label: 'Draft', tone: 'neutral' },
  scheduled: { label: 'Scheduled', tone: 'signal' },
  running: { label: 'Running', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  completed: { label: 'Completed', tone: 'primary' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const MESSAGE_STATUS = {
  scheduled: { label: 'Scheduled', tone: 'signal' },
  sending: { label: 'Sending', tone: 'info' },
  accepted: { label: 'Accepted', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'success' },
  bounced: { label: 'Bounced', tone: 'error' },
  complained: { label: 'Spam report', tone: 'error' },
  failed: { label: 'Failed', tone: 'error' },
  skipped: { label: 'Skipped', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const fullName = (contact) =>
  [contact.firstName, contact.lastName].filter(Boolean).join(' ');

/** A readable line for an activity-log entry. */
export function describeActivity(entry) {
  const who = entry.actor ?? 'Someone';
  const name = entry.metadata?.name;
  const email = entry.metadata?.email;
  const lines = {
    'workspace.created': `${who} created the workspace`,
    'workspace.updated': `${who} updated workspace settings`,
    'contact.created': `${who} added a contact`,
    'contact.updated': `${who} edited a contact`,
    'contact.deleted': `${who} deleted a contact`,
    'contact.unsubscribed': `${email ?? 'A contact'} unsubscribed`,
    'contacts.imported': `${who} imported ${entry.metadata?.created ?? 0} contacts`,
    'list.created': `${who} created a list`,
    'list.deleted': `${who} deleted the list ${name ?? ''}`.trim(),
    'campaign.created': `${who} created ${name ? `“${name}”` : 'a campaign'}`,
    'campaign.updated': `${who} edited a campaign`,
    'campaign.sequence_updated': `${who} updated a campaign sequence`,
    'campaign.deleted': `${who} deleted ${name ? `“${name}”` : 'a campaign'}`,
    'campaign.launched': `${who} launched a campaign to ${entry.metadata?.recipients ?? 0} people`,
    'campaign.paused': `${who} paused a campaign`,
    'campaign.resumed': `${who} resumed a campaign`,
    'campaign.cancelled': `${who} cancelled a campaign`,
    'suppression.added': `${who} blocked ${email ?? 'an address'}`,
    'suppression.removed': `${who} unblocked ${email ?? 'an address'}`,
  };
  return lines[entry.action] ?? entry.action;
}

export function downloadText(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Quotes a CSV cell. A value that starts with = + - or @ would be run as a formula by spreadsheet
 * apps, so it is prefixed with an apostrophe (OWASP's CSV injection guidance).
 */
export function csvCell(value) {
  const text = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

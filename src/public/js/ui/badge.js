import { h } from '../dom.js';
import { CAMPAIGN_STATUS, MESSAGE_STATUS, SUPPRESSION_LABELS } from '../format.js';

export const badge = (text, tone = 'neutral') =>
  h('span', { class: `badge${tone === 'neutral' ? '' : ` badge-${tone}`}` }, text);

export function campaignBadge(status) {
  const meta = CAMPAIGN_STATUS[status] ?? { label: status, tone: 'neutral' };
  return badge(meta.label, meta.tone);
}

export function messageBadge(status) {
  const meta = MESSAGE_STATUS[status] ?? { label: status, tone: 'neutral' };
  return badge(meta.label, meta.tone);
}

export function suppressionBadge(reason) {
  return badge(
    SUPPRESSION_LABELS[reason] ?? reason,
    reason === 'unsubscribed' || reason === 'manual' ? 'warning' : 'error',
  );
}

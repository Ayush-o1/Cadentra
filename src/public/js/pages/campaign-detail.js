import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { summarize, windowSentence } from '../campaign-utils.js';
import { MESSAGE_STATUS, formatDateTime, formatNumber, formatPercent } from '../format.js';
import { state } from '../state.js';
import { campaignBadge, messageBadge } from '../ui/badge.js';
import { confirmDialog } from '../ui/modal.js';
import { emptyState, errorState, pager } from '../ui/states.js';
import { toast, toastError } from '../ui/toast.js';

const POLL_MS = 5000;

function stat(label, value, note) {
  return h(
    'div',
    { class: 'card stat' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, value),
    note && h('div', { class: 'stat-note' }, note),
  );
}

function funnel(counts) {
  const t = summarize(counts);
  const total = Math.max(t.sent + t.waiting + t.failed, 1);
  const seg = (cls, value) => {
    const el = h('span', { class: cls });
    el.style.setProperty('--w', `${(value / total) * 100}%`);
    return el;
  };
  const el = h(
    'div',
    {
      class: 'funnel',
      role: 'img',
      'aria-label': `${t.delivered} delivered, ${t.awaiting} awaiting result, ${t.bounced} bounced, ${t.failed} failed, ${t.waiting} waiting`,
    },
    seg('f-delivered', t.delivered),
    seg('f-accepted', t.awaiting),
    seg('f-bounced', t.bounced),
    seg('f-failed', t.failed),
  );
  return el;
}

export async function campaignDetailPage({ container, params, navigate, isCurrent }) {
  const id = params.id;
  const first = await api.get(`/campaigns/${id}`);
  if (!isCurrent()) return;
  if (first.data.status === 'draft') return navigate(`/campaigns/${id}/edit`, { replace: true });

  let campaign = first.data;
  const view = {
    filter: '',
    cursors: [undefined],
    index: 0,
    messages: [],
    next: null,
    error: null,
  };
  const head = h('div');
  const summary = h('div', { class: 'stack' });
  const messagesCard = h('section', { class: 'card', 'aria-labelledby': 'messages-title' });

  async function act(request, { done }) {
    try {
      const { data } = await request();
      campaign = data;
      toast(done);
      await refreshMessages();
      draw();
    } catch (error) {
      toastError(error);
    }
  }

  async function pause() {
    await act(() => api.post(`/campaigns/${id}/pause`), {
      done: 'Campaign paused. Nothing more will send until you resume it.',
    });
  }

  async function resume() {
    const auto = campaign.pauseReason?.startsWith('Auto-paused');
    if (auto) {
      const ok = await confirmDialog({
        title: 'Resume after an automatic pause?',
        message: `${campaign.pauseReason}. Review the bounced or reported addresses before continuing; sending more to a list like this can damage your sender reputation.`,
        confirmLabel: 'Resume anyway',
        tone: 'danger',
      });
      if (!ok) return;
    }
    await act(() => api.post(`/campaigns/${id}/resume`, { acknowledgeBounceRate: Boolean(auto) }), {
      done: 'Campaign resumed',
    });
  }

  async function cancel() {
    const ok = await confirmDialog({
      title: 'Cancel this campaign?',
      message:
        'Every email that has not been sent yet is cancelled and cannot be restarted. Emails already sent stay in the results.',
      confirmLabel: 'Cancel campaign',
      cancelLabel: 'Keep it',
      tone: 'danger',
    });
    if (ok) await act(() => api.post(`/campaigns/${id}/cancel`), { done: 'Campaign cancelled' });
  }

  function drawHeader() {
    const live = campaign.status === 'running';
    const buttons = [];
    if (campaign.status === 'running' || campaign.status === 'scheduled')
      buttons.push(
        h(
          'button',
          { type: 'button', class: 'btn btn-secondary', onClick: () => void pause() },
          icon('pause'),
          'Pause',
        ),
      );
    if (campaign.status === 'paused')
      buttons.push(
        h(
          'button',
          { type: 'button', class: 'btn btn-primary', onClick: () => void resume() },
          icon('play'),
          'Resume',
        ),
      );
    if (!['completed', 'cancelled'].includes(campaign.status))
      buttons.push(
        h(
          'button',
          { type: 'button', class: 'btn btn-danger-quiet', onClick: () => void cancel() },
          'Cancel campaign',
        ),
      );
    mount(
      head,
      h('a', { class: 'crumb', href: '/campaigns' }, icon('arrow-left'), 'All campaigns'),
      h(
        'div',
        { class: 'page-header' },
        h(
          'div',
          null,
          h('div', { class: 'row' }, h('h1', null, campaign.name), campaignBadge(campaign.status)),
          h(
            'p',
            null,
            campaign.listName ? `Sent to ${campaign.listName}` : '',
            live &&
              h(
                'span',
                null,
                ' · ',
                h('span', { class: 'live-dot', 'aria-hidden': 'true' }),
                'Updating live',
              ),
          ),
        ),
        h('div', { class: 'header-actions' }, buttons),
      ),
      campaign.status === 'paused' &&
        campaign.pauseReason?.startsWith('Auto-paused') &&
        h(
          'div',
          { class: 'alert alert-warning', role: 'alert' },
          icon('alert'),
          h(
            'div',
            { class: 'alert-body' },
            h(
              'span',
              { class: 'alert-title' },
              'Paused automatically to protect your sender reputation',
            ),
            h(
              'span',
              null,
              campaign.pauseReason
                .replace('Auto-paused: ', '')
                .replace(/^./, (c) => c.toUpperCase()) +
                '. Review the bounced addresses in the message list before resuming.',
            ),
          ),
        ),
      campaign.status === 'scheduled' &&
        h(
          'div',
          { class: 'alert alert-info' },
          icon('clock'),
          h(
            'div',
            { class: 'alert-body' },
            `Starts ${formatDateTime(campaign.startAt)}. ${windowSentence(campaign, state.workspace.timezone)}`,
          ),
        ),
    );
  }

  function drawSummary() {
    const t = summarize(campaign.counts);
    mount(
      summary,
      h(
        'div',
        { class: 'stat-grid' },
        stat(
          'Recipients',
          formatNumber(campaign.counts.recipients),
          campaign.counts.skipped
            ? `${formatNumber(campaign.counts.skipped)} skipped (suppressed)`
            : null,
        ),
        stat('Sent', formatNumber(t.sent), 'Accepted by the provider'),
        stat(
          'Delivered',
          t.sent ? formatPercent(t.delivered / t.sent) : '—',
          `${formatNumber(t.delivered)} of ${formatNumber(t.sent)}`,
        ),
        stat(
          'Waiting',
          formatNumber(t.waiting),
          t.failed ? `${formatNumber(t.failed)} failed` : 'To be sent',
        ),
      ),
      h(
        'section',
        { class: 'card', 'aria-labelledby': 'steps-title' },
        h(
          'div',
          { class: 'card-header' },
          h(
            'div',
            null,
            h('h2', { class: 'card-title', id: 'steps-title' }, 'Sequence'),
            h('div', { class: 'card-sub' }, windowSentence(campaign, state.workspace.timezone)),
          ),
        ),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, 'Email'),
                h('th', null, 'Subject'),
                h('th', null, 'Timing'),
                h('th', { class: 'num' }, 'Sent'),
                h('th', { class: 'num' }, 'Delivered'),
                h('th', { class: 'num' }, 'Bounced'),
                h('th', null, 'Progress'),
              ),
            ),
            h(
              'tbody',
              null,
              campaign.steps.map((step) => {
                const s = summarize(step.counts);
                return h(
                  'tr',
                  null,
                  h('td', null, `Email ${step.position}`),
                  h('td', { class: 'cell-main' }, step.subject),
                  h('td', null, step.position === 1 ? 'At launch' : `${step.delayDays} days after`),
                  h('td', { class: 'num' }, formatNumber(s.sent)),
                  h('td', { class: 'num' }, formatNumber(s.delivered)),
                  h('td', { class: 'num' }, formatNumber(s.bounced)),
                  h('td', null, funnel(step.counts)),
                );
              }),
            ),
          ),
        ),
      ),
    );
  }

  const filterSelect = h(
    'select',
    { class: 'select', 'aria-label': 'Filter messages by status' },
    h('option', { value: '' }, 'All statuses'),
    ...Object.entries(MESSAGE_STATUS).map(([value, meta]) => h('option', { value }, meta.label)),
  );
  filterSelect.addEventListener('change', () => {
    view.filter = filterSelect.value;
    view.cursors = [undefined];
    view.index = 0;
    void refreshMessages().then(drawMessages);
  });

  async function refreshMessages() {
    try {
      const { data, meta } = await api.get(`/campaigns/${id}/messages`, {
        status: view.filter,
        cursor: view.cursors[view.index],
        limit: 20,
      });
      view.messages = data;
      view.next = meta.nextCursor;
      view.error = null;
    } catch (error) {
      view.error = error;
    }
  }

  function drawMessages() {
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      h('h2', { class: 'card-title', id: 'messages-title' }, 'Messages'),
      h('span', { class: 'spacer' }),
      filterSelect,
    );
    if (view.error)
      return mount(
        messagesCard,
        toolbar,
        errorState(view.error, () => void refreshMessages().then(drawMessages)),
      );
    if (view.messages.length === 0)
      return mount(
        messagesCard,
        toolbar,
        emptyState({ title: view.filter ? 'No messages with this status' : 'No messages yet' }),
      );
    mount(
      messagesCard,
      toolbar,
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, 'Recipient'),
              h('th', null, 'Email'),
              h('th', null, 'Status'),
              h('th', null, 'When'),
              h('th', null, 'Details'),
            ),
          ),
          h(
            'tbody',
            null,
            view.messages.map((m) =>
              h(
                'tr',
                null,
                h('td', { class: 'cell-main' }, m.toEmail),
                h('td', null, `#${m.step}`),
                h('td', null, messageBadge(m.status)),
                h(
                  'td',
                  { class: 'nowrap' },
                  m.deliveredAt
                    ? `Delivered ${formatDateTime(m.deliveredAt)}`
                    : m.acceptedAt
                      ? `Sent ${formatDateTime(m.acceptedAt)}`
                      : m.failedAt
                        ? formatDateTime(m.failedAt)
                        : `Due ${formatDateTime(m.runAt)}`,
                ),
                h(
                  'td',
                  { class: 'cell-sub' },
                  m.lastError ?? (m.attempts > 1 ? `${m.attempts} attempts` : ''),
                ),
              ),
            ),
          ),
        ),
      ),
      pager({
        summary: 'Newest first',
        hasPrevious: view.index > 0,
        hasNext: Boolean(view.next),
        onPrevious: () => {
          view.index -= 1;
          void refreshMessages().then(drawMessages);
        },
        onNext: () => {
          view.cursors[view.index + 1] = view.next;
          view.index += 1;
          void refreshMessages().then(drawMessages);
        },
      }),
    );
  }

  function draw() {
    drawHeader();
    drawSummary();
    drawMessages();
  }

  mount(container, head, h('div', { class: 'stack' }, summary, messagesCard));
  await refreshMessages();
  draw();

  const timer = setInterval(async () => {
    if (document.hidden || ['completed', 'cancelled'].includes(campaign.status)) return;
    try {
      const { data } = await api.get(`/campaigns/${id}`);
      if (!isCurrent()) return;
      campaign = data;
      await refreshMessages();
      draw();
    } catch {
      /* keep the last good view; the next poll retries */
    }
  }, POLL_MS);
  return () => clearInterval(timer);
}

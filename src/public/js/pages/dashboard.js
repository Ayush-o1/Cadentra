import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { describeActivity, formatNumber, formatPercent, formatRelative } from '../format.js';
import { state } from '../state.js';
import { campaignBadge } from '../ui/badge.js';
import { dailyChart } from '../ui/chart.js';
import { emptyState, loadingBlock } from '../ui/states.js';
import { newCampaignModal } from './campaigns.js';

function stat(label, value, note) {
  return h(
    'div',
    { class: 'card stat' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, value),
    note && h('div', { class: 'stat-note' }, note),
  );
}

/** A rate against its limit: the marker shows where Cadentra pauses a campaign. */
function gauge({ label, rate, limit, limitText }) {
  const width = rate === null ? 0 : Math.min(rate / (limit * 2), 1) * 100;
  const meter = h(
    'div',
    { class: 'meter rate-limit' + (rate !== null && rate >= limit * 0.66 ? ' warn' : '') },
    h('span'),
    h('i', { class: 'marker' }),
  );
  meter.firstChild.style.setProperty('--w', `${width}%`);
  meter.lastChild.style.setProperty('--at', '50%');
  return h(
    'div',
    { class: 'rate-row' },
    h(
      'div',
      { class: 'rate-head' },
      h('span', null, label),
      h('strong', null, formatPercent(rate)),
    ),
    meter,
    h('div', { class: 'help' }, limitText),
  );
}

function deliveryGauge(rate) {
  const meter = h('div', { class: 'meter' }, h('span'));
  meter.firstChild.style.setProperty('--w', `${(rate ?? 0) * 100}%`);
  return h(
    'div',
    { class: 'rate-row' },
    h(
      'div',
      { class: 'rate-head' },
      h('span', null, 'Delivered'),
      h('strong', null, formatPercent(rate)),
    ),
    meter,
    h('div', { class: 'help' }, 'Of emails the provider accepted'),
  );
}

function checklist(data) {
  const workspace = state.workspace;
  const items = [
    {
      done: workspace.launchBlockers.length === 0,
      text: 'Add your sender identity',
      note: 'Name, address and postal address appear in every email.',
      href: '/settings',
      cta: 'Open settings',
    },
    {
      done: data.contacts.total > 0,
      text: 'Add contacts who agreed to hear from you',
      note: 'Import a CSV or add people one by one, with how they consented.',
      href: '/contacts',
      cta: 'Add contacts',
    },
    {
      done: data.campaigns.recent.length > 0,
      text: 'Create your first campaign',
      note: 'Pick a list and write a short sequence of emails.',
      href: '/campaigns',
      cta: 'Create campaign',
    },
  ];
  if (items.every((item) => item.done)) return null;
  return h(
    'section',
    { class: 'card', 'aria-labelledby': 'setup-title' },
    h(
      'div',
      { class: 'card-header' },
      h(
        'div',
        null,
        h('h2', { class: 'card-title', id: 'setup-title' }, 'Get ready to send'),
        h(
          'div',
          { class: 'card-sub' },
          `${items.filter((i) => i.done).length} of ${items.length} done`,
        ),
      ),
    ),
    h(
      'ul',
      { class: 'checklist' },
      items.map((item) =>
        h(
          'li',
          null,
          h('span', { class: `tick${item.done ? ' done' : ''}` }, item.done && icon('check')),
          h(
            'div',
            { class: 'stack' },
            h('span', { class: item.done ? 'done-text' : 'cell-main' }, item.text),
            !item.done && h('span', { class: 'cell-sub' }, item.note),
          ),
          !item.done && h('a', { class: 'btn btn-secondary btn-sm', href: item.href }, item.cta),
        ),
      ),
    ),
  );
}

export async function dashboardPage({ container, isCurrent }) {
  mount(
    container,
    h(
      'div',
      { class: 'page-header' },
      h('div', null, h('h1', null, 'Dashboard'), h('p', null, state.workspace.name)),
    ),
    loadingBlock('Loading dashboard'),
  );
  const { data } = await api.get('/dashboard');
  if (!isCurrent()) return;

  const workspace = state.workspace;
  const timer = setInterval(async () => {
    if (document.hidden) return;
    try {
      const fresh = await api.get('/dashboard');
      if (isCurrent()) render(fresh.data);
    } catch {
      /* The next tick will try again. */
    }
  }, 15000);

  function render(d) {
    const dl = d.delivery;
    const accepted = dl.totals.accepted;
    mount(
      container,
      h(
        'div',
        { class: 'page-header' },
        h('div', null, h('h1', null, 'Dashboard'), h('p', null, workspace.name)),
        h(
          'div',
          { class: 'header-actions' },
          h(
            'button',
            { type: 'button', class: 'btn btn-primary', onClick: () => newCampaignModal() },
            icon('plus'),
            'New campaign',
          ),
        ),
      ),
      h(
        'div',
        { class: 'stack' },
        checklist(d),
        h(
          'div',
          { class: 'stat-grid' },
          stat(
            'Contacts you can email',
            formatNumber(d.contacts.reachable),
            `${formatNumber(d.contacts.total)} total · ${formatNumber(d.contacts.suppressed)} suppressed`,
          ),
          stat(
            'Active campaigns',
            formatNumber(d.campaigns.active),
            d.campaigns.active ? 'Running or scheduled' : 'Nothing running right now',
          ),
          stat(
            'Waiting to send',
            formatNumber(d.messages.scheduled),
            `${formatNumber(d.messages.sentToday)} of ${formatNumber(workspace.dailySendLimit)} sent today`,
          ),
          stat(
            'Delivered, last 30 days',
            formatPercent(dl.rates.delivery),
            accepted
              ? `${formatNumber(dl.totals.delivered)} of ${formatNumber(accepted)} accepted`
              : 'No emails sent yet',
          ),
        ),
        h(
          'div',
          { class: 'grid-2' },
          h(
            'section',
            { class: 'card', 'aria-labelledby': 'sending-title' },
            h(
              'div',
              { class: 'card-header' },
              h(
                'div',
                null,
                h('h2', { class: 'card-title', id: 'sending-title' }, 'Sending, last 30 days'),
                h('div', { class: 'card-sub' }, 'Emails the provider accepted each day'),
              ),
              h('a', { href: '/analytics' }, 'Full analytics'),
            ),
            h(
              'div',
              { class: 'card-pad' },
              accepted === 0
                ? emptyState({
                    title: 'Nothing sent yet',
                    message: 'Once a campaign sends, daily volume and delivery appear here.',
                  })
                : dailyChart(d.trend),
            ),
          ),
          h(
            'section',
            { class: 'card card-pad', 'aria-labelledby': 'health-title' },
            h('h2', { class: 'card-title', id: 'health-title' }, 'Delivery health'),
            h(
              'p',
              { class: 'card-sub' },
              'Cadentra pauses a campaign before these reach your provider’s limits.',
            ),
            h(
              'div',
              { class: 'stack', 'aria-label': 'Rates' },
              deliveryGauge(dl.rates.delivery),
              gauge({
                label: 'Bounced',
                rate: dl.rates.bounce,
                limit: dl.limits.pauseBounce,
                limitText: `Campaigns pause at ${formatPercent(dl.limits.pauseBounce)}`,
              }),
              gauge({
                label: 'Marked as spam',
                rate: dl.rates.complaint,
                limit: dl.limits.pauseComplaint,
                limitText: `Campaigns pause at ${formatPercent(dl.limits.pauseComplaint)}`,
              }),
            ),
          ),
        ),
        h(
          'div',
          { class: 'grid-even' },
          h(
            'section',
            { class: 'card', 'aria-labelledby': 'recent-title' },
            h(
              'div',
              { class: 'card-header' },
              h('h2', { class: 'card-title', id: 'recent-title' }, 'Recent campaigns'),
              h('a', { href: '/campaigns' }, 'View all'),
            ),
            d.campaigns.recent.length
              ? h(
                  'ul',
                  { class: 'link-list' },
                  d.campaigns.recent.map((c) =>
                    h(
                      'li',
                      null,
                      h('a', { href: `/campaigns/${c.id}` }, c.name),
                      campaignBadge(c.status),
                    ),
                  ),
                )
              : emptyState({
                  title: 'No campaigns yet',
                  message: 'Create one to start a sequence.',
                }),
          ),
          h(
            'section',
            { class: 'card', 'aria-labelledby': 'activity-title' },
            h(
              'div',
              { class: 'card-header' },
              h('h2', { class: 'card-title', id: 'activity-title' }, 'Recent activity'),
            ),
            d.activity.length
              ? h(
                  'ul',
                  { class: 'link-list feed' },
                  d.activity.map((a) =>
                    h(
                      'li',
                      null,
                      h('span', null, describeActivity(a)),
                      h('span', { class: 'when' }, formatRelative(a.createdAt)),
                    ),
                  ),
                )
              : emptyState({ title: 'No activity yet' }),
          ),
        ),
      ),
    );
  }

  render(data);
  return () => clearInterval(timer);
}

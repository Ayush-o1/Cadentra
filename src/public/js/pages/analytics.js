import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { formatNumber, formatPercent } from '../format.js';
import { campaignBadge } from '../ui/badge.js';
import { dailyChart } from '../ui/chart.js';
import { selectField } from '../ui/form.js';
import { emptyState, errorState, loadingBlock } from '../ui/states.js';

const stat = (label, value, note) =>
  h(
    'div',
    { class: 'card stat' },
    h('div', { class: 'stat-label' }, label),
    h('div', { class: 'stat-value' }, value),
    note && h('div', { class: 'stat-note' }, note),
  );

const RANGES = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom range' },
];

export async function analyticsPage({ container, query, isCurrent }) {
  const filters = {
    range: query.get('range') ?? '30d',
    campaignId: query.get('campaign') ?? '',
    from: query.get('from') ?? '',
    to: query.get('to') ?? '',
  };
  const { data: campaigns } = await api.get('/campaigns', { limit: 100 });
  if (!isCurrent()) return;

  const results = h('div', { class: 'stack' });
  const range = selectField({
    label: 'Period',
    name: 'range',
    value: filters.range,
    options: RANGES,
  });
  const campaign = selectField({
    label: 'Campaign',
    name: 'campaign',
    value: filters.campaignId,
    options: [
      { value: '', label: 'All campaigns' },
      ...campaigns.map((c) => ({ value: c.id, label: c.name })),
    ],
  });
  const from = h('input', {
    class: 'input',
    type: 'date',
    'aria-label': 'From date',
    value: filters.from,
  });
  const to = h('input', {
    class: 'input',
    type: 'date',
    'aria-label': 'To date (inclusive)',
    value: filters.to,
  });
  const custom = h(
    'div',
    { class: 'row' },
    h('div', { class: 'field' }, h('label', { class: 'label' }, 'From'), from),
    h('div', { class: 'field' }, h('label', { class: 'label' }, 'To'), to),
  );

  async function load() {
    filters.range = range.input.value;
    filters.campaignId = campaign.input.value;
    custom.hidden = filters.range !== 'custom';
    const params = { campaignId: filters.campaignId };
    if (filters.range === 'custom') {
      if (!from.value || !to.value)
        return mount(results, emptyState({ title: 'Choose a start and end date' }));
      params.from = new Date(`${from.value}T00:00:00Z`).toISOString();
      params.to = new Date(new Date(`${to.value}T00:00:00Z`).getTime() + 86_400_000).toISOString();
    } else params.range = filters.range;

    const search = new URLSearchParams({ range: filters.range });
    if (filters.campaignId) search.set('campaign', filters.campaignId);
    if (filters.range === 'custom') {
      search.set('from', from.value);
      search.set('to', to.value);
    }
    window.history.replaceState(null, '', `/analytics?${search}`);

    mount(results, loadingBlock('Loading analytics'));
    try {
      const { data } = await api.get('/analytics', params);
      if (isCurrent()) draw(data);
    } catch (error) {
      if (isCurrent())
        mount(
          results,
          error.status === 422
            ? emptyState({
                title: 'That range is not valid',
                message: error.details?.[0]?.message ?? error.message,
              })
            : errorState(error, () => void load()),
        );
    }
  }

  function draw(data) {
    const t = data.totals;
    const rows = (items, name) =>
      items.length
        ? h(
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
                  h('th', null, name),
                  h('th', { class: 'num' }, 'Sent'),
                  h('th', { class: 'num' }, 'Delivered'),
                  h('th', { class: 'num' }, 'Bounced'),
                  h('th', { class: 'num' }, 'Spam reports'),
                  h('th', { class: 'num' }, 'Awaiting'),
                ),
              ),
              h(
                'tbody',
                null,
                items.map((r) =>
                  h(
                    'tr',
                    null,
                    h(
                      'td',
                      null,
                      r.status
                        ? h(
                            'div',
                            { class: 'row' },
                            h(
                              'a',
                              {
                                class: 'cell-main',
                                href:
                                  r.status === 'draft'
                                    ? `/campaigns/${r.id}/edit`
                                    : `/campaigns/${r.id}`,
                              },
                              r.name,
                            ),
                            campaignBadge(r.status),
                          )
                        : h(
                            'div',
                            null,
                            h('span', { class: 'cell-main' }, `Email ${r.position}`),
                            h('div', { class: 'cell-sub' }, r.subject),
                          ),
                    ),
                    h('td', { class: 'num' }, formatNumber(r.accepted)),
                    h(
                      'td',
                      { class: 'num' },
                      `${formatNumber(r.delivered)} · ${formatPercent(r.rates.delivery)}`,
                    ),
                    h(
                      'td',
                      { class: 'num' },
                      `${formatNumber(r.bounced)} · ${formatPercent(r.rates.bounce)}`,
                    ),
                    h('td', { class: 'num' }, formatNumber(r.complained)),
                    h('td', { class: 'num' }, formatNumber(r.awaiting)),
                  ),
                ),
              ),
            ),
          )
        : null;

    mount(
      results,
      h(
        'div',
        { class: 'stat-grid' },
        stat('Sent', formatNumber(t.accepted), 'Accepted by the provider'),
        stat(
          'Delivered',
          formatPercent(data.rates.delivery),
          `${formatNumber(t.delivered)} reached the inbox server`,
        ),
        stat(
          'Bounced',
          formatPercent(data.rates.bounce),
          `${formatNumber(t.bounced)} emails · pause limit ${formatPercent(data.limits.pauseBounce)}`,
        ),
        stat(
          'Spam reports',
          formatPercent(data.rates.complaint),
          `${formatNumber(t.complained)} emails · pause limit ${formatPercent(data.limits.pauseComplaint)}`,
        ),
      ),
      h(
        'section',
        { class: 'card', 'aria-labelledby': 'daily-title' },
        h(
          'div',
          { class: 'card-header' },
          h(
            'div',
            null,
            h('h2', { class: 'card-title', id: 'daily-title' }, 'Emails per day'),
            h(
              'div',
              { class: 'card-sub' },
              `${formatNumber(t.awaiting)} still awaiting a delivery result · ${formatNumber(t.failed)} could not be sent`,
            ),
          ),
        ),
        h(
          'div',
          { class: 'card-pad' },
          t.accepted
            ? dailyChart(data.series)
            : emptyState({
                title: 'Nothing was sent in this period',
                message: 'Try a longer period, or launch a campaign to see results here.',
              }),
        ),
      ),
      data.steps.length
        ? h(
            'section',
            { class: 'card', 'aria-labelledby': 'steps-title' },
            h(
              'div',
              { class: 'card-header' },
              h(
                'h2',
                { class: 'card-title', id: 'steps-title' },
                'Performance by email in the sequence',
              ),
            ),
            rows(data.steps, 'Email'),
          )
        : null,
      !filters.campaignId && data.campaigns.length
        ? h(
            'section',
            { class: 'card', 'aria-labelledby': 'campaigns-title' },
            h(
              'div',
              { class: 'card-header' },
              h('h2', { class: 'card-title', id: 'campaigns-title' }, 'By campaign'),
            ),
            rows(data.campaigns, 'Campaign'),
          )
        : null,
      h(
        'div',
        { class: 'callout' },
        h(
          'p',
          null,
          'Rates are measured against emails the provider accepted. “Delivered” means the recipient’s mail server took the message. Opens are not tracked: mail apps that preload images make open counts unreliable, so Cadentra does not report them.',
        ),
      ),
    );
  }

  const apply = () => void load();
  range.input.addEventListener('change', apply);
  campaign.input.addEventListener('change', apply);
  from.addEventListener('change', apply);
  to.addEventListener('change', apply);

  mount(
    container,
    h(
      'div',
      { class: 'page-header' },
      h(
        'div',
        null,
        h('h1', null, 'Analytics'),
        h('p', null, 'What actually happened to the email you sent.'),
      ),
    ),
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'card toolbar' }, range.el, campaign.el, custom),
      results,
    ),
  );
  await load();
}

import { api } from '../api.js';
import { debounce, h, mount, latestOnly } from '../dom.js';
import { icon } from '../icons.js';
import { summarize } from '../campaign-utils.js';
import { formatDate, formatNumber, formatPercent } from '../format.js';
import { navigate } from '../router.js';
import { campaignBadge } from '../ui/badge.js';
import { clearErrors, showErrors, textField, withBusy } from '../ui/form.js';
import { openModal } from '../ui/modal.js';
import { emptyState, errorState, pager, skeletonRows } from '../ui/states.js';

export function newCampaignModal() {
  openModal({
    title: 'New campaign',
    description:
      'Give it a name you will recognise. You will choose the audience and write the emails next.',
    size: 'narrow',
    content: (close) => {
      const name = textField({
        label: 'Campaign name',
        name: 'name',
        required: true,
        placeholder: 'Spring expo follow-up',
        maxlength: 160,
      });
      const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create draft');
      const form = h(
        'form',
        { novalidate: true },
        name.el,
        h(
          'div',
          { class: 'form-actions' },
          h(
            'button',
            { type: 'button', class: 'btn btn-secondary', onClick: () => close() },
            'Cancel',
          ),
          submit,
        ),
      );
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        clearErrors(form);
        try {
          const { data } = await withBusy(submit, () =>
            api.post('/campaigns', { name: name.input.value }),
          );
          close();
          await navigate(`/campaigns/${data.id}/edit`);
        } catch (error) {
          showErrors(form, error);
        }
      });
      return form;
    },
  });
}

const TABS = [
  ['', 'All'],
  ['running', 'Running'],
  ['scheduled', 'Scheduled'],
  ['draft', 'Drafts'],
  ['paused', 'Paused'],
  ['completed', 'Completed'],
];

export async function campaignsPage({ container, query, isCurrent }) {
  const view = { status: query.get('status') ?? '', search: '', cursors: [undefined], index: 0 };
  const card = h('div', { class: 'card' });
  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search campaigns',
    'aria-label': 'Search campaigns',
  });
  search.addEventListener(
    'input',
    debounce(() => {
      view.search = search.value.trim();
      resetPaging();
    }),
  );

  const resetPaging = () => {
    view.cursors = [undefined];
    view.index = 0;
    void load();
  };

  const begin = latestOnly();
  async function load() {
    const isLatest = begin();
    try {
      const { data, meta } = await api.get('/campaigns', {
        status: view.status,
        search: view.search,
        cursor: view.cursors[view.index],
        limit: 20,
      });
      if (!isCurrent() || !isLatest()) return;
      view.next = meta.nextCursor;
      draw(data);
    } catch (error) {
      if (isCurrent() && isLatest())
        mount(
          card,
          errorState(error, () => void load()),
        );
    }
  }

  function tabs() {
    return h(
      'div',
      { class: 'tabs', role: 'tablist', 'aria-label': 'Filter by status' },
      TABS.map(([value, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: 'tab',
            role: 'tab',
            'aria-selected': String(view.status === value),
            onClick: () => {
              view.status = value;
              resetPaging();
            },
          },
          label,
        ),
      ),
    );
  }

  function draw(campaigns) {
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'search' }, icon('search'), search),
    );
    if (campaigns.length === 0) {
      const filtered = view.status || view.search;
      mount(
        card,
        tabs(),
        toolbar,
        emptyState({
          title: filtered ? 'No campaigns match' : 'No campaigns yet',
          message: filtered
            ? 'Try another status or search.'
            : 'A campaign sends a short sequence of emails to a list of contacts who agreed to hear from you.',
          action:
            !filtered &&
            h(
              'button',
              { type: 'button', class: 'btn btn-primary', onClick: newCampaignModal },
              icon('plus'),
              'Create your first campaign',
            ),
        }),
      );
      return;
    }
    mount(
      card,
      tabs(),
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
              h('th', null, 'Campaign'),
              h('th', null, 'Status'),
              h('th', null, 'List'),
              h('th', { class: 'num' }, 'Recipients'),
              h('th', { class: 'num' }, 'Sent'),
              h('th', { class: 'num' }, 'Delivered'),
              h('th', null, 'Created'),
            ),
          ),
          h(
            'tbody',
            null,
            campaigns.map((c) => {
              const totals = summarize(c.counts);
              return h(
                'tr',
                null,
                h(
                  'td',
                  null,
                  h(
                    'a',
                    {
                      class: 'cell-main',
                      href: c.status === 'draft' ? `/campaigns/${c.id}/edit` : `/campaigns/${c.id}`,
                    },
                    c.name,
                  ),
                ),
                h('td', null, campaignBadge(c.status)),
                h('td', null, c.listName ?? h('span', { class: 'faint' }, 'Not chosen')),
                h('td', { class: 'num' }, formatNumber(c.counts.recipients)),
                h('td', { class: 'num' }, formatNumber(totals.sent)),
                h(
                  'td',
                  { class: 'num' },
                  totals.sent ? formatPercent(totals.delivered / totals.sent) : '—',
                ),
                h('td', null, formatDate(c.createdAt)),
              );
            }),
          ),
        ),
      ),
      pager({
        summary: 'Newest first',
        hasPrevious: view.index > 0,
        hasNext: Boolean(view.next),
        onPrevious: () => {
          view.index -= 1;
          void load();
        },
        onNext: () => {
          view.cursors[view.index + 1] = view.next;
          view.index += 1;
          void load();
        },
      }),
    );
  }

  mount(
    container,
    h(
      'div',
      { class: 'page-header' },
      h(
        'div',
        null,
        h('h1', null, 'Campaigns'),
        h('p', null, 'Sequences of emails sent to a list over time.'),
      ),
      h(
        'div',
        { class: 'header-actions' },
        h(
          'button',
          { type: 'button', class: 'btn btn-primary', onClick: newCampaignModal },
          icon('plus'),
          'New campaign',
        ),
      ),
    ),
    card,
  );
  mount(card, skeletonRows(6));
  await load();
}

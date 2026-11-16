import { api } from '../api.js';
import { debounce, h, mount, latestOnly } from '../dom.js';
import { icon } from '../icons.js';
import { formatDate, formatNumber, fullName } from '../format.js';
import { clearErrors, showErrors, textField, withBusy } from '../ui/form.js';
import { menuButton } from '../ui/menu.js';
import { confirmDialog, openModal } from '../ui/modal.js';
import { emptyState, errorState, pager, skeletonRows } from '../ui/states.js';
import { toast, toastError } from '../ui/toast.js';
import { suppressionBadge, badge } from '../ui/badge.js';
import { importModal } from './contacts.js';

function nameModal({ list, onSaved }) {
  openModal({
    title: list ? 'Rename list' : 'Create a list',
    size: 'narrow',
    content: (close) => {
      const name = textField({
        label: 'List name',
        name: 'name',
        value: list?.name ?? '',
        required: true,
        placeholder: 'Spring expo leads',
        maxlength: 120,
      });
      const submit = h(
        'button',
        { type: 'submit', class: 'btn btn-primary' },
        list ? 'Save' : 'Create list',
      );
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
            list
              ? api.patch(`/lists/${list.id}`, { name: name.input.value })
              : api.post('/lists', { name: name.input.value }),
          );
          toast(list ? 'List renamed' : 'List created');
          close();
          onSaved(data);
        } catch (error) {
          showErrors(form, error);
        }
      });
      return form;
    },
  });
}

export async function listsPage({ container, isCurrent }) {
  const card = h('div', { class: 'card' });
  const load = async () => {
    try {
      const { data } = await api.get('/lists');
      if (!isCurrent()) return;
      draw(data);
    } catch (error) {
      if (isCurrent())
        mount(
          card,
          errorState(error, () => void load()),
        );
    }
  };

  function draw(lists) {
    if (lists.length === 0) {
      mount(
        card,
        emptyState({
          title: 'No lists yet',
          message: 'Lists group contacts so a campaign knows who to email.',
          action: h(
            'button',
            {
              type: 'button',
              class: 'btn btn-primary',
              onClick: () => nameModal({ onSaved: load }),
            },
            icon('plus'),
            'Create a list',
          ),
        }),
      );
      return;
    }
    mount(
      card,
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
              h('th', null, 'Name'),
              h('th', { class: 'num' }, 'Contacts'),
              h('th', null, 'Created'),
              h('th', { class: 'col-actions' }, h('span', { class: 'sr-only' }, 'Actions')),
            ),
          ),
          h(
            'tbody',
            null,
            lists.map((list) =>
              h(
                'tr',
                null,
                h('td', null, h('a', { class: 'cell-main', href: `/lists/${list.id}` }, list.name)),
                h('td', { class: 'num' }, formatNumber(list.contactCount)),
                h('td', null, formatDate(list.createdAt)),
                h(
                  'td',
                  { class: 'col-actions' },
                  menuButton({
                    label: `Actions for ${list.name}`,
                    items: [
                      { label: 'Open', icon: 'eye', href: `/lists/${list.id}` },
                      {
                        label: 'Rename',
                        icon: 'edit',
                        onSelect: () => nameModal({ list, onSaved: load }),
                      },
                      'separator',
                      {
                        label: 'Delete',
                        icon: 'trash',
                        danger: true,
                        onSelect: () => removeList(list),
                      },
                    ],
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  async function removeList(list) {
    const ok = await confirmDialog({
      title: `Delete “${list.name}”?`,
      message: 'The contacts stay in your workspace; only the list is removed.',
      confirmLabel: 'Delete list',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.delete(`/lists/${list.id}`);
      toast('List deleted');
      await load();
    } catch (error) {
      toastError(error);
    }
  }

  mount(
    container,
    h(
      'div',
      { class: 'page-header' },
      h(
        'div',
        null,
        h('h1', null, 'Lists'),
        h('p', null, 'Groups of contacts you can send a campaign to.'),
      ),
      h(
        'div',
        { class: 'header-actions' },
        h(
          'button',
          { type: 'button', class: 'btn btn-primary', onClick: () => nameModal({ onSaved: load }) },
          icon('plus'),
          'New list',
        ),
      ),
    ),
    card,
  );
  mount(card, skeletonRows(4));
  await load();
}

export async function listDetailPage({ container, params, isCurrent }) {
  const { data: list } = await api.get(`/lists/${params.id}`);
  if (!isCurrent()) return;

  const view = { search: '', cursors: [undefined], index: 0 };
  const card = h('div', { class: 'card' });
  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search this list',
    'aria-label': 'Search this list',
  });
  search.addEventListener(
    'input',
    debounce(() => {
      view.search = search.value.trim();
      view.cursors = [undefined];
      view.index = 0;
      void load();
    }),
  );

  const begin = latestOnly();
  async function load() {
    const isLatest = begin();
    try {
      const { data, meta } = await api.get('/contacts', {
        listId: list.id,
        search: view.search,
        cursor: view.cursors[view.index],
        limit: 25,
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

  function draw(contacts) {
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'search' }, icon('search'), search),
    );
    if (contacts.length === 0) {
      mount(
        card,
        toolbar,
        emptyState({
          title: view.search ? 'No one matches that search' : 'This list is empty',
          message: view.search
            ? undefined
            : 'Add contacts from the Contacts page, or import a CSV straight into this list.',
          action:
            !view.search &&
            h(
              'button',
              {
                type: 'button',
                class: 'btn btn-primary',
                onClick: () =>
                  importModal({ lists: [list], listId: list.id, onDone: () => void load() }),
              },
              icon('upload'),
              'Import CSV into this list',
            ),
        }),
      );
      return;
    }
    mount(
      card,
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
              h('th', null, 'Contact'),
              h('th', null, 'Company'),
              h('th', null, 'Status'),
              h('th', { class: 'col-actions' }, h('span', { class: 'sr-only' }, 'Actions')),
            ),
          ),
          h(
            'tbody',
            null,
            contacts.map((c) =>
              h(
                'tr',
                null,
                h(
                  'td',
                  null,
                  h('div', { class: 'cell-main' }, fullName(c) || c.email),
                  fullName(c) && h('div', { class: 'cell-sub' }, c.email),
                ),
                h('td', null, c.company ?? h('span', { class: 'faint' }, '—')),
                h(
                  'td',
                  null,
                  c.suppressionReason
                    ? suppressionBadge(c.suppressionReason)
                    : badge('Can be emailed', 'success'),
                ),
                h(
                  'td',
                  { class: 'col-actions' },
                  menuButton({
                    label: `Actions for ${c.email}`,
                    items: [
                      {
                        label: 'Remove from list',
                        icon: 'x',
                        danger: true,
                        onSelect: async () => {
                          try {
                            await api.delete(`/lists/${list.id}/members/${c.id}`);
                            toast('Removed from the list');
                            await load();
                          } catch (error) {
                            toastError(error);
                          }
                        },
                      },
                    ],
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
      pager({
        summary: `${formatNumber(list.contactCount)} in this list`,
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
    h('a', { class: 'crumb', href: '/lists' }, icon('arrow-left'), 'All lists'),
    h(
      'div',
      { class: 'page-header' },
      h(
        'div',
        null,
        h('h1', null, list.name),
        h(
          'p',
          null,
          `${formatNumber(list.contactCount)} contacts · created ${formatDate(list.createdAt)}`,
        ),
      ),
      h(
        'div',
        { class: 'header-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-secondary',
            onClick: () =>
              importModal({ lists: [list], listId: list.id, onDone: () => void load() }),
          },
          icon('upload'),
          'Import CSV',
        ),
        h(
          'a',
          { class: 'btn btn-primary', href: `/contacts?list=${list.id}` },
          'Manage in contacts',
        ),
      ),
    ),
    card,
  );
  mount(card, skeletonRows(5));
  await load();
}

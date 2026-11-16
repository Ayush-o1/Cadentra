import { api } from '../api.js';
import { debounce, h, mount, latestOnly } from '../dom.js';
import { icon } from '../icons.js';
import { formatDate } from '../format.js';
import { suppressionBadge } from '../ui/badge.js';
import { clearErrors, showErrors, textField, withBusy } from '../ui/form.js';
import { menuButton } from '../ui/menu.js';
import { confirmDialog, openModal } from '../ui/modal.js';
import { emptyState, errorState, pager, skeletonRows } from '../ui/states.js';
import { toast, toastError } from '../ui/toast.js';

function blockModal(onSaved) {
  openModal({
    title: 'Block an address',
    description: 'Cadentra will never email it, and pending emails to it are cancelled.',
    size: 'narrow',
    content: (close) => {
      const email = textField({
        label: 'Email address',
        name: 'email',
        type: 'email',
        required: true,
      });
      const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Block address');
      const form = h(
        'form',
        { novalidate: true },
        email.el,
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
          await withBusy(submit, () => api.post('/suppressions', { email: email.input.value }));
          toast('Address blocked');
          close();
          onSaved();
        } catch (error) {
          showErrors(form, error);
        }
      });
      return form;
    },
  });
}

export async function suppressionsPage({ container, isCurrent }) {
  const view = { search: '', cursors: [undefined], index: 0 };
  const card = h('div', { class: 'card' });
  const search = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search addresses',
    'aria-label': 'Search suppressed addresses',
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
      const { data, meta } = await api.get('/suppressions', {
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

  function draw(entries) {
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'search' }, icon('search'), search),
    );
    if (entries.length === 0) {
      mount(
        card,
        toolbar,
        emptyState({
          title: view.search ? 'No addresses match that search' : 'Nobody is suppressed',
          message: view.search
            ? undefined
            : 'Unsubscribes, bounces and spam reports are added here automatically.',
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
              h('th', null, 'Address'),
              h('th', null, 'Reason'),
              h('th', null, 'Added'),
              h('th', { class: 'col-actions' }, h('span', { class: 'sr-only' }, 'Actions')),
            ),
          ),
          h(
            'tbody',
            null,
            entries.map((entry) =>
              h(
                'tr',
                null,
                h('td', { class: 'cell-main' }, entry.email),
                h('td', null, suppressionBadge(entry.reason)),
                h('td', null, formatDate(entry.createdAt)),
                h(
                  'td',
                  { class: 'col-actions' },
                  entry.reason === 'manual'
                    ? menuButton({
                        label: `Actions for ${entry.email}`,
                        items: [
                          {
                            label: 'Unblock',
                            icon: 'x',
                            danger: true,
                            onSelect: () => unblock(entry),
                          },
                        ],
                      })
                    : h(
                        'span',
                        {
                          class: 'faint',
                          title: 'Opt-outs, bounces and spam reports are permanent',
                        },
                        icon('shield'),
                      ),
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

  async function unblock(entry) {
    const ok = await confirmDialog({
      title: `Unblock ${entry.email}?`,
      message: 'They can be emailed again in future campaigns.',
      confirmLabel: 'Unblock',
    });
    if (!ok) return;
    try {
      await api.delete(`/suppressions/${entry.id}`);
      toast('Address unblocked');
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
        h('h1', null, 'Suppression list'),
        h('p', null, 'Addresses Cadentra will never email.'),
      ),
      h(
        'div',
        { class: 'header-actions' },
        h(
          'button',
          { type: 'button', class: 'btn btn-primary', onClick: () => blockModal(load) },
          icon('ban'),
          'Block an address',
        ),
      ),
    ),
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'callout' },
        icon('shield'),
        h(
          'p',
          null,
          'Unsubscribes, bounces and spam reports can never be removed from this list. That is what keeps your sender reputation, and your recipients’ trust, intact. Only addresses you blocked yourself can be unblocked.',
        ),
      ),
      card,
    ),
  );
  mount(card, skeletonRows(5));
  await load();
}

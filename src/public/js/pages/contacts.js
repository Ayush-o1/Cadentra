import { api } from '../api.js';
import { debounce, h, latestOnly, mount } from '../dom.js';
import { icon } from '../icons.js';
import {
  CONSENT_LABELS,
  consentChange,
  csvCell,
  downloadText,
  formatDate,
  formatNumber,
  fullName,
} from '../format.js';
import { badge, suppressionBadge } from '../ui/badge.js';
import { clearErrors, selectField, showErrors, textField, withBusy } from '../ui/form.js';
import { menuButton } from '../ui/menu.js';
import { confirmDialog, openModal } from '../ui/modal.js';
import { emptyState, errorState, pager, skeletonRows } from '../ui/states.js';
import { toast, toastError } from '../ui/toast.js';

const CONSENT_OPTIONS = Object.entries(CONSENT_LABELS).map(([value, label]) => ({ value, label }));

export async function contactsPage({ container, query, isCurrent }) {
  const view = {
    search: query.get('search') ?? '',
    listId: query.get('list') ?? '',
    status: query.get('status') ?? 'all',
    cursors: [undefined],
    index: 0,
    selected: new Map(),
    lists: [],
  };

  const tableCard = h('div', { class: 'card' });
  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Search by name, email or company',
    'aria-label': 'Search contacts',
    value: view.search,
  });
  const listSelect = h('select', { class: 'select', 'aria-label': 'Filter by list' });
  const statusSelect = h(
    'select',
    { class: 'select', 'aria-label': 'Filter by status' },
    [
      ['all', 'All contacts'],
      ['active', 'Can be emailed'],
      ['suppressed', 'Suppressed'],
    ].map(([value, label]) => h('option', { value, selected: view.status === value }, label)),
  );

  const syncUrl = () => {
    const params = new URLSearchParams();
    if (view.search) params.set('search', view.search);
    if (view.listId) params.set('list', view.listId);
    if (view.status !== 'all') params.set('status', view.status);
    window.history.replaceState(null, '', params.size ? `/contacts?${params}` : '/contacts');
  };

  const reset = () => {
    view.cursors = [undefined];
    view.index = 0;
    view.selected.clear();
    syncUrl();
    void load();
  };

  searchInput.addEventListener(
    'input',
    debounce(() => {
      view.search = searchInput.value.trim();
      reset();
    }),
  );
  listSelect.addEventListener('change', () => {
    view.listId = listSelect.value;
    reset();
  });
  statusSelect.addEventListener('change', () => {
    view.status = statusSelect.value;
    reset();
  });

  const drawListOptions = () => {
    listSelect.replaceChildren(
      h('option', { value: '' }, 'All lists'),
      ...view.lists.map((list) =>
        h(
          'option',
          { value: list.id, selected: String(list.id) === view.listId },
          `${list.name} (${formatNumber(list.contactCount)})`,
        ),
      ),
    );
  };

  const begin = latestOnly();
  async function load() {
    const isLatest = begin();
    tableCard.setAttribute('aria-busy', 'true');
    try {
      const { data, meta } = await api.get('/contacts', {
        search: view.search,
        listId: view.listId,
        status: view.status,
        cursor: view.cursors[view.index],
        limit: 25,
      });
      if (!isCurrent() || !isLatest()) return;
      view.nextCursor = meta.nextCursor;
      drawTable(data);
    } catch (error) {
      if (isCurrent() && isLatest())
        mount(
          tableCard,
          errorState(error, () => void load()),
        );
    } finally {
      if (isLatest()) tableCard.removeAttribute('aria-busy');
    }
  }

  function drawTable(contacts) {
    const toolbar = h(
      'div',
      { class: 'toolbar' },
      h('div', { class: 'search' }, icon('search'), searchInput),
      listSelect,
      statusSelect,
    );

    if (contacts.length === 0) {
      const filtered = view.search || view.listId || view.status !== 'all';
      mount(
        tableCard,
        toolbar,
        emptyState({
          title: filtered ? 'No contacts match these filters' : 'No contacts yet',
          message: filtered
            ? 'Try a different search or clear the filters.'
            : 'Add the people who agreed to hear from you. Every contact records how they consented.',
          action: filtered
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-secondary',
                  onClick: () => {
                    view.search = '';
                    view.listId = '';
                    view.status = 'all';
                    searchInput.value = '';
                    statusSelect.value = 'all';
                    listSelect.value = '';
                    reset();
                  },
                },
                'Clear filters',
              )
            : h(
                'div',
                { class: 'row' },
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-primary',
                    onClick: () => contactModal({ lists: view.lists, onSaved: reloadAll }),
                  },
                  icon('plus'),
                  'Add contact',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'btn btn-secondary',
                    onClick: () => importModal({ lists: view.lists, onDone: reloadAll }),
                  },
                  icon('upload'),
                  'Import CSV',
                ),
              ),
        }),
      );
      return;
    }

    const pageIds = contacts.map((c) => c.id);
    const allChecked = pageIds.every((id) => view.selected.has(id));
    const headerCheck = h('input', {
      type: 'checkbox',
      'aria-label': 'Select all contacts on this page',
      checked: allChecked,
    });
    headerCheck.addEventListener('change', () => {
      for (const c of contacts)
        headerCheck.checked ? view.selected.set(c.id, c) : view.selected.delete(c.id);
      drawTable(contacts);
    });

    const bulk = view.selected.size
      ? h(
          'div',
          { class: 'bulk-bar', role: 'status' },
          h('strong', null, `${view.selected.size} selected`),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-secondary btn-sm',
              onClick: () =>
                addToListModal({
                  ids: [...view.selected.keys()],
                  lists: view.lists,
                  onDone: () => {
                    view.selected.clear();
                    reloadAll();
                  },
                }),
            },
            icon('list'),
            'Add to list',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-quiet btn-sm',
              onClick: () => {
                view.selected.clear();
                drawTable(contacts);
              },
            },
            'Clear selection',
          ),
        )
      : null;

    const rows = contacts.map((contact) => {
      const check = h('input', {
        type: 'checkbox',
        'aria-label': `Select ${contact.email}`,
        checked: view.selected.has(contact.id),
      });
      check.addEventListener('change', () => {
        check.checked ? view.selected.set(contact.id, contact) : view.selected.delete(contact.id);
        drawTable(contacts);
      });
      const name = fullName(contact);
      return h(
        'tr',
        null,
        h('td', { class: 'col-check' }, check),
        h(
          'td',
          null,
          h('div', { class: 'cell-main' }, name || contact.email),
          name && h('div', { class: 'cell-sub' }, contact.email),
        ),
        h('td', null, contact.company ?? h('span', { class: 'faint' }, '—')),
        h(
          'td',
          null,
          contact.lists.length
            ? h(
                'div',
                { class: 'row' },
                contact.lists.slice(0, 2).map((l) => h('span', { class: 'chip' }, l.name)),
                contact.lists.length > 2 &&
                  h('span', { class: 'chip' }, `+${contact.lists.length - 2}`),
              )
            : h('span', { class: 'faint' }, '—'),
        ),
        h(
          'td',
          { class: 'nowrap' },
          h('div', null, CONSENT_LABELS[contact.consentBasis]),
          h('div', { class: 'cell-sub' }, formatDate(contact.consentedAt)),
        ),
        h(
          'td',
          null,
          contact.suppressionReason
            ? suppressionBadge(contact.suppressionReason)
            : badge('Can be emailed', 'success'),
        ),
        h(
          'td',
          { class: 'col-actions' },
          menuButton({
            label: `Actions for ${contact.email}`,
            items: [
              {
                label: 'Edit',
                icon: 'edit',
                onSelect: () => contactModal({ contact, lists: view.lists, onSaved: reloadAll }),
              },
              {
                label: 'Add to list',
                icon: 'list',
                onSelect: () =>
                  addToListModal({ ids: [contact.id], lists: view.lists, onDone: reloadAll }),
              },
              'separator',
              {
                label: 'Delete',
                icon: 'trash',
                danger: true,
                onSelect: () => deleteContact(contact),
              },
            ],
          }),
        ),
      );
    });

    const from = view.index * 25 + 1;
    mount(
      tableCard,
      toolbar,
      bulk,
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
              h('th', { class: 'col-check' }, headerCheck),
              h('th', null, 'Contact'),
              h('th', null, 'Company'),
              h('th', null, 'Lists'),
              h('th', null, 'Consent'),
              h('th', null, 'Status'),
              h('th', { class: 'col-actions' }, h('span', { class: 'sr-only' }, 'Actions')),
            ),
          ),
          h('tbody', null, rows),
        ),
      ),
      pager({
        summary: `Showing ${from}–${from + contacts.length - 1}`,
        hasPrevious: view.index > 0,
        hasNext: Boolean(view.nextCursor),
        onPrevious: () => {
          view.index -= 1;
          void load();
        },
        onNext: () => {
          view.cursors[view.index + 1] = view.nextCursor;
          view.index += 1;
          void load();
        },
      }),
    );
  }

  async function deleteContact(contact) {
    const ok = await confirmDialog({
      title: `Delete ${contact.email}?`,
      message:
        'This removes the contact and its campaign history. If they had opted out, that stays on the suppression list so they cannot be emailed again.',
      confirmLabel: 'Delete contact',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.delete(`/contacts/${contact.id}`);
      toast('Contact deleted');
      view.selected.delete(contact.id);
      reloadAll();
    } catch (error) {
      toastError(error);
    }
  }

  async function reloadAll() {
    const { data } = await api.get('/lists');
    view.lists = data;
    drawListOptions();
    await load();
  }

  mount(
    container,
    h(
      'div',
      { class: 'page-header' },
      h(
        'div',
        null,
        h('h1', null, 'Contacts'),
        h('p', null, 'People who agreed to hear from you, and how they consented.'),
      ),
      h(
        'div',
        { class: 'header-actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-secondary',
            onClick: () => importModal({ lists: view.lists, onDone: reloadAll }),
          },
          icon('upload'),
          'Import CSV',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary',
            onClick: () => contactModal({ lists: view.lists, onSaved: reloadAll }),
          },
          icon('plus'),
          'Add contact',
        ),
      ),
    ),
    tableCard,
  );
  mount(tableCard, skeletonRows(8));
  await reloadAll();
}

/** Add or edit one contact. */
export function contactModal({ contact, lists, onSaved }) {
  const editing = Boolean(contact);
  openModal({
    title: editing ? 'Edit contact' : 'Add a contact',
    description: editing ? undefined : 'Only add people who agreed to hear from you.',
    content: (close) => {
      const email = textField({
        label: 'Email',
        name: 'email',
        type: 'email',
        value: contact?.email ?? '',
        required: true,
        autocomplete: 'off',
      });
      const first = textField({
        label: 'First name',
        name: 'firstName',
        value: contact?.firstName ?? '',
        optional: true,
      });
      const last = textField({
        label: 'Last name',
        name: 'lastName',
        value: contact?.lastName ?? '',
        optional: true,
      });
      const company = textField({
        label: 'Company',
        name: 'company',
        value: contact?.company ?? '',
        optional: true,
      });
      const basis = selectField({
        label: 'How did they consent?',
        name: 'consentBasis',
        value: contact?.consentBasis ?? 'requested_contact',
        options: CONSENT_OPTIONS,
        required: true,
      });
      const source = textField({
        label: 'Where, exactly?',
        name: 'consentSource',
        value: contact?.consentSource ?? '',
        optional: true,
        placeholder: 'Spring expo sign-up sheet',
        help: 'Kept as your record of consent.',
      });
      const date = editing
        ? textField({
            label: 'Consent date',
            name: 'consentedAt',
            type: 'date',
            value: contact.consentedAt.slice(0, 10),
          })
        : null;
      const chosen = new Set();
      const listBoxes =
        !editing && lists.length
          ? h(
              'fieldset',
              { class: 'field' },
              h(
                'legend',
                { class: 'label' },
                'Add to lists',
                h('span', { class: 'optional' }, '(optional)'),
              ),
              h(
                'div',
                { class: 'stack' },
                lists.map((list) =>
                  h(
                    'label',
                    { class: 'check' },
                    h('input', {
                      type: 'checkbox',
                      onChange: (e) =>
                        e.target.checked ? chosen.add(list.id) : chosen.delete(list.id),
                    }),
                    list.name,
                  ),
                ),
              ),
            )
          : null;
      const submit = h(
        'button',
        { type: 'submit', class: 'btn btn-primary' },
        editing ? 'Save changes' : 'Add contact',
      );

      const form = h(
        'form',
        { novalidate: true },
        email.el,
        h('div', { class: 'form-grid' }, first.el, last.el),
        company.el,
        h('div', { class: 'form-grid' }, basis.el, date?.el ?? source.el),
        editing && source.el,
        listBoxes,
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
        const body = {
          email: email.input.value,
          firstName: first.input.value,
          lastName: last.input.value,
          company: company.input.value,
          consentBasis: basis.input.value,
          consentSource: source.input.value,
        };
        if (editing) {
          const changed = consentChange(contact.consentedAt, date.input.value);
          if (changed) body.consentedAt = changed;
        } else if (chosen.size) body.listIds = [...chosen];
        try {
          await withBusy(submit, () =>
            editing ? api.patch(`/contacts/${contact.id}`, body) : api.post('/contacts', body),
          );
          toast(editing ? 'Contact updated' : 'Contact added');
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

function addToListModal({ ids, lists, onDone }) {
  openModal({
    title: ids.length === 1 ? 'Add to a list' : `Add ${ids.length} contacts to a list`,
    size: 'narrow',
    content: (close) => {
      if (lists.length === 0) {
        return h(
          'div',
          null,
          h('p', { class: 'muted' }, 'You have no lists yet. Create one first.'),
          h(
            'div',
            { class: 'form-actions' },
            h(
              'a',
              { class: 'btn btn-primary', href: '/lists', onClick: () => close() },
              'Go to lists',
            ),
          ),
        );
      }
      const select = selectField({
        label: 'List',
        name: 'listId',
        options: lists.map((l) => ({ value: l.id, label: l.name })),
      });
      const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Add to list');
      const form = h(
        'form',
        { novalidate: true },
        select.el,
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
        try {
          const { data } = await withBusy(submit, () =>
            api.post(`/lists/${select.input.value}/members`, { contactIds: ids }),
          );
          toast(
            data.added === ids.length
              ? 'Added to the list'
              : `${data.added} added, the rest were already on it`,
          );
          close();
          onDone();
        } catch (error) {
          showErrors(form, error);
        }
      });
      return form;
    },
  });
}

/** Choose a CSV, say how everyone consented, then see exactly what happened to each row. */
export function importModal({ lists, onDone, listId }) {
  openModal({
    title: 'Import contacts from CSV',
    size: 'wide',
    content: (close) => {
      let file = null;
      const body = h('div');
      const chooser = h('input', {
        type: 'file',
        accept: '.csv,text/csv',
        class: 'sr-only',
        id: 'csv-file',
        tabindex: '-1',
      });
      const fileName = h('strong', null, 'Choose a CSV file');
      const zone = h(
        'label',
        { class: 'dropzone', for: 'csv-file' },
        icon('upload'),
        fileName,
        h('span', { class: 'muted' }, 'or drop it here. Up to 5,000 rows, with an “email” column.'),
      );
      const setFile = (picked) => {
        if (!picked) return;
        file = picked;
        fileName.textContent = picked.name;
      };
      chooser.addEventListener('change', () => setFile(chooser.files[0]));
      zone.addEventListener('dragover', (event) => {
        event.preventDefault();
        zone.classList.add('over');
      });
      zone.addEventListener('dragleave', () => zone.classList.remove('over'));
      zone.addEventListener('drop', (event) => {
        event.preventDefault();
        zone.classList.remove('over');
        setFile(event.dataTransfer.files[0]);
      });

      const basis = selectField({
        label: 'How did everyone in this file consent?',
        name: 'consentBasis',
        value: '',
        options: [{ value: '', label: 'Choose one…' }, ...CONSENT_OPTIONS],
        required: true,
        help: 'Applies to every row. Import separate files for different groups.',
      });
      const source = textField({
        label: 'Source',
        name: 'source',
        optional: true,
        placeholder: 'Spring expo 2026 sign-up sheet',
      });
      const target = selectField({
        label: 'Add to list',
        name: 'listId',
        value: listId ?? '',
        options: [
          { value: '', label: 'No list' },
          ...lists.map((l) => ({ value: l.id, label: l.name })),
        ],
        optional: true,
      });
      const confirm = h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', name: 'confirm' }),
        h(
          'span',
          null,
          'These people agreed to receive email from us. I am not importing a purchased or scraped list.',
        ),
      );
      const submit = h(
        'button',
        { type: 'submit', class: 'btn btn-primary' },
        icon('upload'),
        'Import contacts',
      );

      const form = h(
        'form',
        { novalidate: true },
        chooser,
        zone,
        basis.el,
        h('div', { class: 'form-grid' }, source.el, target.el),
        h('div', { class: 'field' }, confirm),
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
        if (!file) return showErrors(form, { message: 'Choose a CSV file to import.' });
        if (!basis.input.value)
          return showErrors(form, {
            details: [{ path: 'consentBasis', message: 'Choose how these contacts consented.' }],
          });
        if (!confirm.querySelector('input').checked)
          return showErrors(form, {
            message: 'Confirm that these contacts agreed to hear from you.',
          });
        try {
          const text = await file.text();
          const { data } = await withBusy(submit, () =>
            api.postCsv('/contacts/import', text, {
              consentBasis: basis.input.value,
              source: source.input.value || file.name,
              listId: target.input.value,
            }),
          );
          mount(body, report(data, close));
          onDone();
        } catch (error) {
          showErrors(form, error);
        }
      });
      mount(body, form);
      return body;
    },
  });
}

function report(result, close) {
  const tile = (value, label) =>
    h('div', null, h('strong', null, formatNumber(value)), h('span', null, label));
  const errors = result.errors.length
    ? h(
        'div',
        null,
        h(
          'div',
          { class: 'row' },
          h(
            'strong',
            null,
            `${result.errors.length}${result.errorsTruncated ? '+' : ''} rows need attention`,
          ),
        ),
        h(
          'div',
          { class: 'error-table' },
          h(
            'table',
            { class: 'table' },
            h(
              'thead',
              null,
              h('tr', null, h('th', null, 'Row'), h('th', null, 'Email'), h('th', null, 'Why')),
            ),
            h(
              'tbody',
              null,
              result.errors.map((e) =>
                h(
                  'tr',
                  null,
                  h('td', null, e.row),
                  h('td', null, e.email ?? '—'),
                  h('td', null, e.message),
                ),
              ),
            ),
          ),
        ),
      )
    : null;
  return h(
    'div',
    null,
    h(
      'div',
      { class: 'alert alert-success' },
      icon('check-circle'),
      h(
        'div',
        { class: 'alert-body' },
        h('span', { class: 'alert-title' }, `${formatNumber(result.created)} contacts imported`),
        result.suppressed > 0 &&
          h(
            'span',
            null,
            `${formatNumber(result.suppressed)} of the addresses in this file are on your suppression list and will not be emailed.`,
          ),
      ),
    ),
    h(
      'div',
      { class: 'import-result' },
      tile(result.totalRows, 'Rows'),
      tile(result.created, 'Added'),
      tile(result.duplicates, 'Already there'),
      tile(result.invalid, 'Invalid'),
    ),
    errors,
    h(
      'div',
      { class: 'form-actions' },
      result.errors.length > 0 &&
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-secondary',
            onClick: () =>
              downloadText(
                'import-problems.csv',
                [
                  'row,email,problem',
                  ...result.errors.map((e) =>
                    [e.row, csvCell(e.email), csvCell(e.message)].join(','),
                  ),
                ].join('\n'),
              ),
          },
          icon('download'),
          'Download problems',
        ),
      h('button', { type: 'button', class: 'btn btn-primary', onClick: () => close() }, 'Done'),
    ),
  );
}

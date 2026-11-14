import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { hourLabel } from '../campaign-utils.js';
import { formatDateTime, formatNumber } from '../format.js';
import { refreshWorkspace, setIdentity, state } from '../state.js';
import {
  clearErrors,
  selectField,
  showErrors,
  textField,
  textareaField,
  withBusy,
} from '../ui/form.js';
import { confirmDialog } from '../ui/modal.js';
import { loadingBlock } from '../ui/states.js';
import { toast, toastError } from '../ui/toast.js';

const TABS = [
  ['profile', 'Profile'],
  ['sender', 'Sender identity'],
  ['delivery', 'Email delivery'],
  ['security', 'Security'],
];

const timeZones = () => {
  const zones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
};

function section(title, description, ...content) {
  return h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card-header' },
      h(
        'div',
        null,
        h('h2', { class: 'card-title' }, title),
        description && h('div', { class: 'card-sub' }, description),
      ),
    ),
    h('div', { class: 'card-pad' }, content),
  );
}

function profileTab() {
  const name = textField({ label: 'Name', name: 'name', value: state.user.name, required: true });
  const email = textField({
    label: 'Email',
    name: 'email',
    value: state.user.email,
    disabled: true,
    help: 'Your sign-in address. It cannot be changed yet.',
  });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save changes');
  const form = h(
    'form',
    { novalidate: true },
    name.el,
    email.el,
    h('div', { class: 'form-actions' }, submit),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors(form);
    try {
      const { data } = await withBusy(submit, () =>
        api.patch('/account/profile', { name: name.input.value }),
      );
      setIdentity(data);
      toast('Profile saved');
    } catch (error) {
      showErrors(form, error);
    }
  });
  return section('Your profile', undefined, form);
}

function senderTab(rerender) {
  const w = state.workspace;
  const owner = w.role === 'owner';
  const name = textField({
    label: 'Workspace name',
    name: 'name',
    value: w.name,
    required: true,
    disabled: !owner,
  });
  const senderName = textField({
    label: 'Sender name',
    name: 'senderName',
    value: w.senderName ?? '',
    placeholder: 'Priya at Northwind',
    help: 'Recipients see this as the sender.',
    disabled: !owner,
  });
  const senderEmail = textField({
    label: 'Sender email',
    name: 'senderEmail',
    type: 'email',
    value: w.senderEmail ?? '',
    placeholder: 'priya@northwind.example',
    help: 'Must be on a domain you have verified with your email provider.',
    disabled: !owner,
  });
  const reply = textField({
    label: 'Reply-to email',
    name: 'replyToEmail',
    type: 'email',
    value: w.replyToEmail ?? '',
    optional: true,
    disabled: !owner,
  });
  const address = textareaField({
    label: 'Postal address',
    name: 'postalAddress',
    value: w.postalAddress ?? '',
    rows: 3,
    placeholder: '12 Harbour Road\nBristol BS1 4AA\nUnited Kingdom',
    help: 'Shown in the footer of every email. Anti-spam laws require a real address.',
    disabled: !owner,
  });
  const zone = selectField({
    label: 'Time zone',
    name: 'timezone',
    value: w.timezone,
    options: timeZones().map((z) => ({ value: z, label: z })),
    disabled: !owner,
  });
  const hours = (from, to) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      value: from + i,
      label: hourLabel(from + i),
    }));
  const start = selectField({
    label: 'Sending window opens',
    name: 'windowStartHour',
    value: w.windowStartHour,
    options: hours(0, 23),
    disabled: !owner,
  });
  const end = selectField({
    label: 'Sending window closes',
    name: 'windowEndHour',
    value: w.windowEndHour,
    options: hours(1, 24),
    disabled: !owner,
  });
  const weekdays = h('input', { type: 'checkbox', checked: w.weekdaysOnly, disabled: !owner });
  const limit = textField({
    label: 'Daily send limit',
    name: 'dailySendLimit',
    type: 'number',
    value: String(w.dailySendLimit),
    min: '1',
    max: '100000',
    help: 'The most emails Cadentra will send in one UTC day. Keep it within your provider’s plan.',
    disabled: !owner,
  });
  const submit = h(
    'button',
    { type: 'submit', class: 'btn btn-primary', disabled: !owner },
    'Save settings',
  );
  const form = h(
    'form',
    { novalidate: true },
    owner
      ? null
      : h(
          'div',
          { class: 'alert alert-info' },
          icon('info'),
          'Only the workspace owner can change these settings.',
        ),
    name.el,
    h('div', { class: 'form-grid' }, senderName.el, senderEmail.el),
    reply.el,
    address.el,
    h('div', { class: 'form-grid' }, zone.el, limit.el),
    h('div', { class: 'form-grid' }, start.el, end.el),
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'check' }, weekdays, 'Send on weekdays only (default for new campaigns)'),
    ),
    h('div', { class: 'form-actions' }, submit),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors(form);
    const body = {
      name: name.input.value,
      senderName: senderName.input.value || null,
      senderEmail: senderEmail.input.value || null,
      replyToEmail: reply.input.value || null,
      postalAddress: address.input.value || null,
      timezone: zone.input.value,
      windowStartHour: Number(start.input.value),
      windowEndHour: Number(end.input.value),
      weekdaysOnly: weekdays.checked,
      dailySendLimit: Number(limit.input.value),
    };
    try {
      await withBusy(submit, () => api.patch('/workspace', body));
      await refreshWorkspace();
      toast('Settings saved');
      rerender();
    } catch (error) {
      showErrors(form, error);
    }
  });
  const status = state.workspace.launchBlockers.length
    ? h(
        'div',
        { class: 'alert alert-warning' },
        icon('alert'),
        h(
          'div',
          { class: 'alert-body' },
          h('span', { class: 'alert-title' }, 'Not ready to send yet'),
          h(
            'ul',
            null,
            state.workspace.launchBlockers.map((b) => h('li', null, b)),
          ),
        ),
      )
    : h(
        'div',
        { class: 'alert alert-success' },
        icon('check-circle'),
        'Your sender identity is complete. Campaigns can launch.',
      );
  return h(
    'div',
    { class: 'stack' },
    status,
    section(
      'Sender identity and sending limits',
      'This appears in every email and decides when campaigns may send.',
      form,
    ),
  );
}

function deliveryTab() {
  const { provider, sentToday, dailySendLimit } = state.workspace;
  const hook = `${window.location.origin}/webhooks/resend`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hook);
      toast('Webhook URL copied');
    } catch {
      toast('Copy is not available here. Select the URL and copy it manually.', { tone: 'error' });
    }
  };
  return h(
    'div',
    { class: 'stack' },
    provider.simulated
      ? h(
          'div',
          { class: 'alert alert-warning' },
          icon('alert'),
          h(
            'div',
            { class: 'alert-body' },
            h('span', { class: 'alert-title' }, 'Simulated delivery'),
            h(
              'span',
              null,
              'This workspace is running with a fake email provider, so nothing is sent. Messages move through accepted, delivered and bounced states as a simulation. Set EMAIL_PROVIDER=resend with your API key to send real email.',
            ),
          ),
        )
      : h(
          'div',
          { class: 'alert alert-success' },
          icon('check-circle'),
          h(
            'div',
            { class: 'alert-body' },
            h('span', { class: 'alert-title' }, 'Connected to Resend'),
            h('span', null, 'Emails are sent through your Resend account.'),
          ),
        ),
    section(
      'Provider',
      undefined,
      h(
        'dl',
        { class: 'kv' },
        h('dt', null, 'Provider'),
        h('dd', null, provider.simulated ? 'Simulated (development)' : 'Resend'),
        h('dt', null, 'Sent today'),
        h('dd', null, `${formatNumber(sentToday)} of ${formatNumber(dailySendLimit)}`),
        h('dt', null, 'API key'),
        h('dd', null, 'Set on the server as RESEND_API_KEY. It is never shown here.'),
      ),
    ),
    !provider.simulated &&
      section(
        'Delivery webhook',
        'Resend reports delivered, bounced and spam events to this address.',
        h(
          'div',
          { class: 'copy-row' },
          h('div', { class: 'code-block' }, hook),
          h(
            'button',
            { type: 'button', class: 'btn btn-secondary', onClick: () => void copy() },
            icon('copy'),
            'Copy',
          ),
        ),
        h(
          'p',
          { class: 'help' },
          'In Resend, add a webhook with this URL for all email events, then set RESEND_WEBHOOK_SECRET to its signing secret.',
        ),
      ),
  );
}

function securityTab(rerender) {
  const current = textField({
    label: 'Current password',
    name: 'currentPassword',
    type: 'password',
    autocomplete: 'current-password',
    required: true,
  });
  const next = textField({
    label: 'New password',
    name: 'newPassword',
    type: 'password',
    autocomplete: 'new-password',
    required: true,
    help: 'At least 10 characters. Changing it signs out your other devices.',
  });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Change password');
  const form = h(
    'form',
    { novalidate: true },
    current.el,
    next.el,
    h('div', { class: 'form-actions' }, submit),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors(form);
    try {
      await withBusy(submit, () =>
        api.post('/account/password', {
          currentPassword: current.input.value,
          newPassword: next.input.value,
        }),
      );
      toast('Password changed. Other devices were signed out.');
      form.reset();
      rerender();
    } catch (error) {
      showErrors(form, error);
    }
  });

  const sessions = h('div', null, loadingBlock('Loading sessions'));
  async function loadSessions() {
    try {
      const { data } = await api.get('/account/sessions');
      mount(
        sessions,
        data.map((s) =>
          h(
            'div',
            { class: 'session-row' },
            h(
              'div',
              null,
              h(
                'div',
                { class: 'cell-main' },
                (s.userAgent ?? 'Unknown device').slice(0, 70),
                s.current && h('span', { class: 'badge badge-primary' }, 'This device'),
              ),
              h(
                'div',
                { class: 'cell-sub' },
                `Last active ${formatDateTime(s.lastSeenAt)}${s.ipAddress ? ` · ${s.ipAddress}` : ''}`,
              ),
            ),
            !s.current &&
              h(
                'button',
                {
                  type: 'button',
                  class: 'btn btn-danger-quiet btn-sm',
                  onClick: async () => {
                    if (
                      !(await confirmDialog({
                        title: 'Sign out this device?',
                        message: 'It will need to sign in again.',
                        confirmLabel: 'Sign out device',
                        tone: 'danger',
                      }))
                    )
                      return;
                    try {
                      await api.delete(`/account/sessions/${s.id}`);
                      toast('Device signed out');
                      await loadSessions();
                    } catch (error) {
                      toastError(error);
                    }
                  },
                },
                'Sign out',
              ),
          ),
        ),
      );
    } catch (error) {
      mount(sessions, h('div', { class: 'card-pad' }, error.message));
    }
  }
  void loadSessions();
  return h(
    'div',
    { class: 'stack' },
    section('Change password', undefined, form),
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-header' },
        h(
          'div',
          null,
          h('h2', { class: 'card-title' }, 'Where you are signed in'),
          h('div', { class: 'card-sub' }, 'Sign out any device you do not recognise.'),
        ),
      ),
      sessions,
    ),
  );
}

export async function settingsPage({ container, query }) {
  let tab = TABS.some(([key]) => key === query.get('tab')) ? query.get('tab') : 'profile';
  await refreshWorkspace();
  const panel = h('div', { role: 'tabpanel', tabindex: '0' });
  const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Settings sections' });

  const rerender = () => {
    mount(
      tabs,
      TABS.map(([key, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: 'tab',
            role: 'tab',
            id: `tab-${key}`,
            'aria-selected': String(tab === key),
            onClick: () => {
              tab = key;
              window.history.replaceState(null, '', `/settings?tab=${key}`);
              rerender();
            },
          },
          label,
        ),
      ),
    );
    panel.setAttribute('aria-labelledby', `tab-${tab}`);
    mount(
      panel,
      {
        profile: profileTab,
        sender: () => senderTab(rerender),
        delivery: deliveryTab,
        security: () => securityTab(rerender),
      }[tab](),
    );
  };
  tabs.addEventListener('keydown', (event) => {
    const index = TABS.findIndex(([key]) => key === tab);
    const move = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!move) return;
    tab = TABS[(index + move + TABS.length) % TABS.length][0];
    rerender();
    tabs.querySelector('[aria-selected="true"]').focus();
  });

  mount(
    container,
    h(
      'div',
      { class: 'page-header' },
      h(
        'div',
        null,
        h('h1', null, 'Settings'),
        h('p', null, 'Your account, sender identity and email delivery.'),
      ),
    ),
    h('div', { class: 'settings-layout stack' }, tabs, panel),
  );
  rerender();
}

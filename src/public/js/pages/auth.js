import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { brandMark, icon } from '../icons.js';
import { loadSession } from '../state.js';
import { clearErrors, showErrors, textField, withBusy } from '../ui/form.js';

const safeNext = (value) =>
  value && value.startsWith('/') && !value.startsWith('//') ? value : '/';

function aside() {
  const point = (iconName, title, text) =>
    h('li', null, icon(iconName), h('div', null, h('strong', null, title), text));
  return h(
    'div',
    { class: 'auth-aside' },
    h('h2', null, 'Outreach that people agreed to receive.'),
    h(
      'ul',
      { class: 'principles' },
      point(
        'shield',
        'Consent is recorded',
        'Every contact carries when and why they agreed to hear from you.',
      ),
      point(
        'ban',
        'Opt-outs are immediate',
        'An unsubscribe stops every pending email, and the app cannot undo it.',
      ),
      point(
        'check-circle',
        'Delivery comes from the provider',
        'Accepted, delivered, bounced and spam reports are kept apart, never guessed.',
      ),
    ),
    h(
      'div',
      { class: 'cadence-rule', 'aria-hidden': 'true' },
      Array.from({ length: 14 }, () => h('i')),
    ),
  );
}

function layout(container, card) {
  mount(
    container,
    h('div', { class: 'auth' }, h('div', { class: 'auth-form-side' }, card), aside()),
  );
}

export function loginPage({ container, query, navigate }) {
  const email = textField({
    label: 'Email',
    name: 'email',
    type: 'email',
    autocomplete: 'email',
    required: true,
    placeholder: 'you@company.com',
  });
  const password = textField({
    label: 'Password',
    name: 'password',
    type: 'password',
    autocomplete: 'current-password',
    required: true,
  });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Sign in');

  const form = h('form', { novalidate: true }, email.el, password.el, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors(form);
    try {
      await withBusy(submit, async () => {
        await api.post(
          '/auth/login',
          { email: email.input.value, password: password.input.value },
          { silent: true },
        );
        await loadSession();
      });
      await navigate(safeNext(query.get('next')), { replace: true });
    } catch (error) {
      showErrors(form, error);
    }
  });

  layout(
    container,
    h(
      'div',
      { class: 'auth-card' },
      h('a', { class: 'brand', href: '/login' }, brandMark(), 'Cadentra'),
      h('h1', null, 'Sign in'),
      h('p', { class: 'lead' }, 'Pick up where your campaigns left off.'),
      form,
      h(
        'p',
        { class: 'auth-switch' },
        'New to Cadentra? ',
        h('a', { href: '/register' }, 'Create an account'),
      ),
    ),
  );
  email.input.focus();
}

export function registerPage({ container, navigate }) {
  const name = textField({
    label: 'Your name',
    name: 'name',
    autocomplete: 'name',
    required: true,
  });
  const email = textField({
    label: 'Work email',
    name: 'email',
    type: 'email',
    autocomplete: 'email',
    required: true,
    placeholder: 'you@company.com',
  });
  const password = textField({
    label: 'Password',
    name: 'password',
    type: 'password',
    autocomplete: 'new-password',
    required: true,
    help: 'At least 10 characters.',
  });
  const workspace = textField({
    label: 'Team or company',
    name: 'workspaceName',
    optional: true,
    placeholder: 'Northwind Trading',
    help: 'Shown in the sidebar. You can change it later.',
  });
  const submit = h(
    'button',
    { type: 'submit', class: 'btn btn-primary btn-block' },
    'Create account',
  );

  const form = h(
    'form',
    { novalidate: true },
    name.el,
    email.el,
    password.el,
    workspace.el,
    submit,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors(form);
    const body = {
      name: name.input.value,
      email: email.input.value,
      password: password.input.value,
    };
    if (workspace.input.value.trim()) body.workspaceName = workspace.input.value;
    try {
      await withBusy(submit, async () => {
        await api.post('/auth/register', body, { silent: true });
        await loadSession();
      });
      await navigate('/', { replace: true });
    } catch (error) {
      showErrors(form, error);
    }
  });

  layout(
    container,
    h(
      'div',
      { class: 'auth-card' },
      h('a', { class: 'brand', href: '/register' }, brandMark(), 'Cadentra'),
      h('h1', null, 'Create your account'),
      h('p', { class: 'lead' }, 'Set up a workspace for your team in a minute.'),
      form,
      h(
        'p',
        { class: 'auth-switch' },
        'Already have an account? ',
        h('a', { href: '/login' }, 'Sign in'),
      ),
    ),
  );
  name.input.focus();
}

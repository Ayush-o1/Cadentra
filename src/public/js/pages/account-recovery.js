import { api } from '../api.js';
import { h } from '../dom.js';
import { brandMark, icon } from '../icons.js';
import { clearSession, loadSession, state } from '../state.js';
import { clearErrors, showErrors, textField, withBusy } from '../ui/form.js';
import { layout } from './auth.js';

const card = (...content) =>
  h(
    'div',
    { class: 'auth-card' },
    h('a', { class: 'brand', href: '/login' }, brandMark(), 'Cadentra'),
    ...content,
  );

const alertBox = (tone, iconName, ...content) =>
  h(
    'div',
    { class: `alert alert-${tone}`, role: tone === 'error' ? 'alert' : 'status' },
    icon(iconName),
    h('div', { class: 'alert-body' }, ...content),
  );

/**
 * Reads the one-time secret from the URL fragment (`#token=…`) and removes it from the address bar.
 * The fragment is never sent to the server, so it stays out of access logs and Referer headers.
 */
function takeToken() {
  const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token');
  if (window.location.hash) {
    window.history.replaceState(null, '', window.location.pathname);
  }
  return token && token.length >= 20 ? token : null;
}

export function forgotPasswordPage({ container }) {
  const email = textField({
    label: 'Email',
    name: 'email',
    type: 'email',
    autocomplete: 'email',
    required: true,
    placeholder: 'you@company.com',
  });
  const submit = h(
    'button',
    { type: 'submit', class: 'btn btn-primary btn-block' },
    'Send reset link',
  );
  const form = h('form', { novalidate: true }, email.el, submit);
  const body = card(
    h('h1', null, 'Reset your password'),
    h(
      'p',
      { class: 'lead' },
      'Enter your account email and we will send you a link to choose a new password.',
    ),
    form,
    h('p', { class: 'auth-switch' }, h('a', { href: '/login' }, 'Back to sign in')),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors(form);
    const address = email.input.value.trim();
    try {
      await withBusy(submit, () =>
        api.post('/auth/forgot-password', { email: address }, { silent: true }),
      );
      form.replaceWith(
        alertBox(
          'success',
          'check-circle',
          h('strong', null, 'Check your inbox'),
          `If an account exists for ${address}, a reset link is on its way. It works for one hour.`,
        ),
      );
    } catch (error) {
      showErrors(form, error);
    }
  });

  layout(container, body);
  email.input.focus();
}

export function resetPasswordPage({ container, navigate }) {
  const token = takeToken();
  if (!token) {
    layout(
      container,
      card(
        h('h1', null, 'Reset link incomplete'),
        alertBox(
          'error',
          'alert',
          'This link is missing its secret. Open the link from the email again, or request a new one.',
        ),
        h(
          'p',
          { class: 'auth-switch' },
          h('a', { href: '/forgot-password' }, 'Request a new link'),
        ),
      ),
    );
    return;
  }

  const password = textField({
    label: 'New password',
    name: 'newPassword',
    type: 'password',
    autocomplete: 'new-password',
    required: true,
    help: 'At least 10 characters.',
  });
  const confirm = textField({
    label: 'Repeat new password',
    name: 'confirm',
    type: 'password',
    autocomplete: 'new-password',
    required: true,
  });
  const submit = h(
    'button',
    { type: 'submit', class: 'btn btn-primary btn-block' },
    'Update password',
  );
  const form = h('form', { novalidate: true }, password.el, confirm.el, submit);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors(form);
    if (password.input.value !== confirm.input.value) {
      showErrors(form, {
        message: 'The passwords do not match',
        details: [{ path: 'confirm', message: 'The passwords do not match' }],
      });
      return;
    }
    try {
      await withBusy(submit, () =>
        api.post(
          '/auth/reset-password',
          { token, newPassword: password.input.value },
          { silent: true },
        ),
      );
      // The server ended every session, including this browser's, if it had one.
      clearSession();
      await navigate('/login?reset=1', { replace: true });
    } catch (error) {
      if (error.code === 'INVALID_TOKEN') {
        form.replaceWith(
          alertBox('error', 'alert', error.message),
          h(
            'p',
            { class: 'auth-switch' },
            h('a', { href: '/forgot-password' }, 'Request a new link'),
          ),
        );
        return;
      }
      showErrors(form, error);
    }
  });

  layout(
    container,
    card(
      h('h1', null, 'Choose a new password'),
      h('p', { class: 'lead' }, 'You will be signed out everywhere and asked to sign in again.'),
      form,
    ),
  );
  password.input.focus();
}

export function verifyEmailPage({ container }) {
  const token = takeToken();
  const status = h('div', { role: 'status', 'aria-live': 'polite' });
  const body = card(h('h1', null, 'Confirm your email'), status);
  layout(container, body);

  const finish = (node, linkText, href) =>
    status.replaceChildren(node, h('p', { class: 'auth-switch' }, h('a', { href }, linkText)));

  if (!token) {
    finish(
      alertBox(
        'error',
        'alert',
        'This link is missing its secret. Open the link from the email again.',
      ),
      'Go to Cadentra',
      '/',
    );
    return;
  }
  status.append(h('p', { class: 'lead' }, 'Confirming…'));
  api
    .post('/auth/verify-email', { token }, { silent: true })
    .then(async () => {
      if (state.user) await loadSession();
      finish(
        alertBox(
          'success',
          'check-circle',
          h('strong', null, 'Email confirmed'),
          'Thank you. You can close this tab or carry on.',
        ),
        state.user ? 'Go to the dashboard' : 'Sign in',
        state.user ? '/' : '/login',
      );
    })
    .catch((error) => finish(alertBox('error', 'alert', error.message), 'Go to Cadentra', '/'));
}

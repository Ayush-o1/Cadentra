import { h } from '../dom.js';
import { icon } from '../icons.js';

let region;

function ensureRegion() {
  if (!region) {
    region = h('div', { class: 'toast-region', role: 'region', 'aria-label': 'Notifications' });
    document.body.append(region);
  }
  return region;
}

/** @param {string} message @param {{tone?: 'success' | 'error' | 'info', duration?: number}} [options] */
export function toast(message, { tone = 'success', duration = 4500 } = {}) {
  const isError = tone === 'error';
  const dismiss = () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  const el = h(
    'div',
    { class: `toast ${tone}`, role: isError ? 'alert' : 'status' },
    icon(isError ? 'alert' : tone === 'info' ? 'info' : 'check-circle'),
    h('div', { class: 'toast-text' }, message),
    h(
      'button',
      { type: 'button', 'aria-label': 'Dismiss notification', onClick: dismiss },
      icon('x'),
    ),
  );
  ensureRegion().append(el);
  if (duration > 0) setTimeout(dismiss, duration);
}

export const toastError = (error) =>
  toast(error?.message ?? 'Something went wrong. Please try again.', {
    tone: 'error',
    duration: 7000,
  });

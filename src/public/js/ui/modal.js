import { h, uid } from '../dom.js';
import { icon } from '../icons.js';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Opens an accessible dialog: focus moves into it, Tab stays inside, Escape and a click on the
 * backdrop close it, and focus returns to what had it before.
 *
 * @param {{title: string, description?: string, size?: 'narrow' | 'wide', dismissable?: boolean, content: (close: (value?: any) => void) => Node}} options
 * @returns {{close: (value?: any) => void, result: Promise<any>}}
 */
export function openModal({ title, description, size, dismissable = true, content }) {
  const previouslyFocused = document.activeElement;
  const titleId = uid('modal-title');
  let finish;
  const result = new Promise((resolve) => {
    finish = resolve;
  });

  const close = (value) => {
    document.removeEventListener('keydown', onKeydown);
    backdrop.remove();
    document.body.style.removeProperty('overflow');
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    finish(value);
  };

  const dialog = h(
    'div',
    {
      class: `modal${size ? ` ${size}` : ''}`,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      tabindex: '-1',
    },
    h(
      'div',
      { class: 'modal-header' },
      h(
        'div',
        null,
        h('h2', { id: titleId }, title),
        description && h('p', { class: 'muted' }, description),
      ),
      dismissable &&
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-quiet btn-icon btn-sm',
            'aria-label': 'Close',
            onClick: () => close(),
          },
          icon('x'),
        ),
    ),
    h('div', { class: 'modal-body' }, content(close)),
  );

  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);
  backdrop.addEventListener('mousedown', (event) => {
    if (dismissable && event.target === backdrop) close();
  });

  function onKeydown(event) {
    if (event.key === 'Escape' && dismissable) {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  document.addEventListener('keydown', onKeydown);
  document.body.style.overflow = 'hidden';
  document.body.append(backdrop);
  const firstField = dialog.querySelector(
    '.modal-body input, .modal-body select, .modal-body textarea',
  );
  (firstField ?? dialog.querySelector('.modal-body button') ?? dialog).focus();

  return { close, result };
}

/** @returns {Promise<boolean>} */
export async function confirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  tone = 'primary',
  cancelLabel = 'Cancel',
}) {
  const { result } = openModal({
    title,
    size: 'narrow',
    content: (close) =>
      h(
        'div',
        null,
        h('p', { class: 'muted' }, message),
        h(
          'div',
          { class: 'form-actions' },
          h(
            'button',
            { type: 'button', class: 'btn btn-secondary', onClick: () => close(false) },
            cancelLabel,
          ),
          h(
            'button',
            {
              type: 'button',
              class: `btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`,
              onClick: () => close(true),
            },
            confirmLabel,
          ),
        ),
      ),
  });
  return (await result) === true;
}

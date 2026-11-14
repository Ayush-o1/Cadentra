import { h } from '../dom.js';
import { icon } from '../icons.js';

export function emptyState({ title, message, action }) {
  return h(
    'div',
    { class: 'empty' },
    h(
      'div',
      { class: 'empty-mark', 'aria-hidden': 'true' },
      [1, 2, 3, 4, 5].map(() => h('span')),
    ),
    h('h3', null, title),
    message && h('p', null, message),
    action,
  );
}

export function errorState(error, retry) {
  return h(
    'div',
    { class: 'empty' },
    h(
      'div',
      { class: 'alert alert-error', role: 'alert' },
      icon('alert'),
      h('div', { class: 'alert-body' }, error?.message ?? 'Something went wrong.'),
    ),
    retry &&
      h(
        'button',
        { type: 'button', class: 'btn btn-secondary', onClick: retry },
        icon('refresh'),
        'Try again',
      ),
  );
}

export function skeletonRows(count = 6) {
  return h(
    'div',
    { 'aria-hidden': 'true' },
    Array.from({ length: count }, () => h('div', { class: 'skeleton skeleton-line' })),
  );
}

export function loadingBlock(label = 'Loading') {
  return h('div', { role: 'status', 'aria-label': label }, skeletonRows(5));
}

/** Previous/Next controls for cursor pagination. */
export function pager({ hasPrevious, hasNext, onPrevious, onNext, summary }) {
  return h(
    'div',
    { class: 'table-footer' },
    h('span', null, summary),
    h(
      'div',
      { class: 'pager' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-secondary btn-sm',
          disabled: !hasPrevious,
          onClick: onPrevious,
        },
        icon('chevron-left'),
        'Previous',
      ),
      h(
        'button',
        { type: 'button', class: 'btn btn-secondary btn-sm', disabled: !hasNext, onClick: onNext },
        'Next',
        icon('chevron-right'),
      ),
    ),
  );
}

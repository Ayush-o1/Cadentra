import { h, mount } from '../dom.js';
import { emptyState } from '../ui/states.js';

export function notFoundPage({ container }) {
  mount(
    container,
    h(
      'div',
      { class: 'page' },
      emptyState({
        title: 'This page does not exist',
        message: 'The link may be out of date, or the item may have been deleted.',
        action: h('a', { class: 'btn btn-primary', href: '/' }, 'Back to the dashboard'),
      }),
    ),
  );
}

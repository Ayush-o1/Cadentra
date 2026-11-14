import { api } from '../api.js';
import { h, mount } from '../dom.js';
import { brandMark, icon } from '../icons.js';
import { withBusy } from '../ui/form.js';
import { loadingBlock } from '../ui/states.js';

export async function unsubscribePage({ container, params }) {
  const card = h('div', { class: 'card' }, loadingBlock('Loading'));
  mount(container, h('div', { class: 'center-card' }, card));

  const frame = (...children) =>
    mount(
      card,
      h('div', { class: 'row' }, brandMark(), h('strong', null, 'Cadentra')),
      ...children,
    );

  let info;
  try {
    ({ data: info } = await api.get(`/public/unsubscribe/${encodeURIComponent(params.token)}`));
  } catch {
    frame(
      h('h1', null, 'This link is not valid'),
      h(
        'p',
        { class: 'muted' },
        'It may have been copied incorrectly. Use the unsubscribe link in the most recent email, or reply to the sender and ask to be removed.',
      ),
    );
    return;
  }

  const done = () =>
    frame(
      h(
        'div',
        { class: 'alert alert-success' },
        icon('check-circle'),
        h(
          'div',
          { class: 'alert-body' },
          h('span', { class: 'alert-title' }, 'You are unsubscribed'),
          h('span', null, `${info.email} will not receive any more email from ${info.sender}.`),
        ),
      ),
    );
  if (info.alreadyUnsubscribed) return done();

  const button = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary',
      onClick: async (event) => {
        try {
          await withBusy(event.currentTarget, () =>
            api.post(`/public/unsubscribe/${encodeURIComponent(params.token)}`),
          );
          done();
        } catch (error) {
          card.append(h('p', { class: 'error-text', role: 'alert' }, error.message));
        }
      },
    },
    'Unsubscribe',
  );

  frame(
    h('h1', null, 'Unsubscribe from these emails?'),
    h(
      'p',
      { class: 'muted' },
      `${info.email} will stop receiving email from ${info.sender}. This takes effect immediately.`,
    ),
    button,
  );
}

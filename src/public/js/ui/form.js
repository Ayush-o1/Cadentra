import { h, uid } from '../dom.js';
import { icon } from '../icons.js';

/**
 * Builds a labelled control. Returns the wrapper and the control so callers can read the value.
 * Errors from the server are attached later with `showErrors`, matched by the control's `name`.
 */
function control(
  kind,
  { label, name, value = '', help, optional = false, required = false, options = [], ...attrs },
) {
  const id = uid(name ?? 'field');
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const props = {
    id,
    name,
    class: kind === 'select' ? 'select' : kind === 'textarea' ? 'textarea' : 'input',
    required,
    'aria-describedby': help ? `${helpId} ${errorId}` : errorId,
    ...attrs,
  };

  let input;
  if (kind === 'select') {
    input = h(
      'select',
      props,
      options.map(({ value: v, label: l }) =>
        h('option', { value: v, selected: String(v) === String(value) }, l),
      ),
    );
  } else if (kind === 'textarea') {
    input = h('textarea', props, value);
  } else {
    input = h('input', { type: 'text', ...props, value });
  }

  const wrapper = h(
    'div',
    { class: 'field', 'data-field': name },
    label &&
      h(
        'label',
        { class: 'label', for: id },
        label,
        optional && h('span', { class: 'optional' }, '(optional)'),
      ),
    input,
    help && h('div', { class: 'help', id: helpId }, help),
    h('div', { id: errorId, class: 'error-text', hidden: true, role: 'alert' }),
  );
  return { el: wrapper, input };
}

export const textField = (options) => control('input', options);
export const textareaField = (options) => control('textarea', options);
export const selectField = (options) => control('select', options);

export function clearErrors(root) {
  for (const input of root.querySelectorAll('[aria-invalid]'))
    input.removeAttribute('aria-invalid');
  for (const message of root.querySelectorAll('.error-text')) {
    message.hidden = true;
    message.replaceChildren();
  }
  root.querySelector('[data-form-error]')?.remove();
}

/**
 * Shows server validation details next to their fields. Anything that does not match a field
 * is shown as a banner at the top of the form, so no error is ever silently dropped.
 */
export function showErrors(root, error) {
  clearErrors(root);
  const unmatched = [];
  const details = error.details?.length ? error.details : [{ path: '', message: error.message }];
  let first = null;

  for (const { path, message } of details) {
    const field = path
      ? (root.querySelector(`[data-path="${path}"]`) ??
        root.querySelector(`[data-field="${path.split('.').at(-1)}"]`))
      : null;
    if (!field) {
      unmatched.push(message);
      continue;
    }
    const input = field.querySelector('input, select, textarea');
    const target = field.querySelector('.error-text');
    input?.setAttribute('aria-invalid', 'true');
    target.hidden = false;
    target.replaceChildren(icon('alert'), message);
    first ??= input;
  }

  if (unmatched.length) {
    root.prepend(
      h(
        'div',
        { class: 'alert alert-error', role: 'alert', 'data-form-error': '' },
        icon('alert'),
        h(
          'div',
          { class: 'alert-body' },
          unmatched.length === 1
            ? unmatched[0]
            : h(
                'ul',
                null,
                unmatched.map((m) => h('li', null, m)),
              ),
        ),
      ),
    );
  }
  first?.focus();
}

/** Runs `task` while the button shows a spinner and cannot be pressed again. */
export async function withBusy(button, task) {
  const original = [...button.childNodes];
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  button.replaceChildren(
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    ...original.map((n) => n.cloneNode(true)),
  );
  try {
    return await task();
  } finally {
    button.removeAttribute('aria-busy');
    button.disabled = false;
    button.replaceChildren(...original);
  }
}

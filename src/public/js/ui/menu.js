import { h, uid } from '../dom.js';
import { icon } from '../icons.js';

/**
 * A dropdown menu button with full keyboard support (arrows, Home/End, Escape, type to open).
 *
 * @param {{label: string, trigger?: Node, buttonClass?: string, align?: 'left' | 'right', dropUp?: boolean,
 *   items: Array<{label: string, icon?: string, danger?: boolean, onSelect?: () => void, href?: string} | 'separator'>}} options
 */
export function menuButton({
  label,
  trigger,
  buttonClass = 'btn btn-quiet btn-icon btn-sm',
  align = 'right',
  dropUp = false,
  items,
}) {
  const menuId = uid('menu');
  let menu = null;

  const button = h(
    'button',
    {
      type: 'button',
      class: buttonClass,
      'aria-label': trigger ? null : label,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'aria-controls': menuId,
    },
    trigger ?? icon('more'),
  );
  const anchor = h('span', { class: 'menu-anchor' }, button);

  const entries = () => [...(menu?.querySelectorAll('[role="menuitem"]') ?? [])];

  function close({ restoreFocus = true } = {}) {
    if (!menu) return;
    menu.remove();
    menu = null;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside, true);
    if (restoreFocus) button.focus();
  }

  function onOutside(event) {
    if (!anchor.contains(event.target)) close({ restoreFocus: false });
  }

  function open(focus = 'first') {
    if (menu) return;
    menu = h(
      'div',
      {
        class: `menu${align === 'right' ? ' align-right' : ''}${dropUp ? ' drop-up' : ''}`,
        role: 'menu',
        id: menuId,
        'aria-label': label,
      },
      items.map((item) => {
        if (item === 'separator') return h('div', { class: 'menu-sep', role: 'separator' });
        const tag = item.href ? 'a' : 'button';
        return h(
          tag,
          {
            class: `menu-item${item.danger ? ' danger' : ''}`,
            role: 'menuitem',
            tabindex: '-1',
            href: item.href,
            type: item.href ? null : 'button',
            onClick: () => {
              close({ restoreFocus: !item.href });
              item.onSelect?.();
            },
          },
          item.icon && icon(item.icon),
          item.label,
        );
      }),
    );
    menu.addEventListener('keydown', onMenuKey);
    anchor.append(menu);
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onOutside, true);
    const list = entries();
    (focus === 'last' ? list.at(-1) : list[0])?.focus();
  }

  function onMenuKey(event) {
    const list = entries();
    const index = list.indexOf(document.activeElement);
    const keys = {
      ArrowDown: () => list[(index + 1) % list.length],
      ArrowUp: () => list[(index - 1 + list.length) % list.length],
      Home: () => list[0],
      End: () => list.at(-1),
    };
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      close({ restoreFocus: false });
    } else if (keys[event.key]) {
      event.preventDefault();
      keys[event.key]()?.focus();
    }
  }

  button.addEventListener('click', () => (menu ? close() : open()));
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      open('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      open('last');
    }
  });

  return anchor;
}

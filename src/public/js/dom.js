// A tiny element builder. Text is always inserted as text nodes, never parsed as HTML,
// so user-supplied data cannot inject markup.

const PROPERTY_KEYS = new Set([
  'value',
  'checked',
  'disabled',
  'selected',
  'readOnly',
  'indeterminate',
]);

/**
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** @param {string} tag @param {Record<string, any> | null} [props] @param {...any} children */
export function svg(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

function applyProps(el, props) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.setAttribute('class', value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (PROPERTY_KEYS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Replaces everything inside `container`. */
export function mount(container, ...nodes) {
  container.replaceChildren();
  append(container, nodes);
}

export function debounce(fn, delay = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

let idCounter = 0;
export const uid = (prefix = 'id') => `${prefix}-${++idCounter}`;

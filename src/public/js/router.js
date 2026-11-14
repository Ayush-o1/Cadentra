const routes = [];
let current = { cleanup: null, token: 0 };
let renderPage = async () => {};

/** Pattern like /campaigns/:id/edit becomes a matcher that returns named params. */
function compile(pattern) {
  const names = [];
  const source = pattern.replace(/:([a-zA-Z]+)/g, (_, name) => {
    names.push(name);
    return '([^/]+)';
  });
  const regex = new RegExp(`^${source}/?$`);
  return (path) => {
    const match = regex.exec(path);
    return match
      ? Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(match[i + 1])]))
      : null;
  };
}

export function defineRoutes(definitions) {
  routes.length = 0;
  for (const definition of definitions)
    routes.push({ ...definition, match: compile(definition.path) });
}

export function setRenderer(fn) {
  renderPage = fn;
}

export function resolve(path) {
  for (const route of routes) {
    const params = route.match(path);
    if (params) return { route, params };
  }
  return null;
}

export async function navigate(to, { replace = false } = {}) {
  const url = new URL(to, window.location.origin);
  const target = url.pathname + url.search;
  if (target !== window.location.pathname + window.location.search) {
    window.history[replace ? 'replaceState' : 'pushState'](null, '', target);
  }
  await show();
}

export async function show() {
  const token = ++current.token;
  const url = new URL(window.location.href);
  const matched = resolve(url.pathname);
  current.cleanup?.();
  current.cleanup = null;
  const cleanup = await renderPage(matched, url, () => token === current.token);
  if (token === current.token) current.cleanup = cleanup ?? null;
  else cleanup?.();
}

export function startRouter() {
  window.addEventListener('popstate', () => void show());
  document.addEventListener('click', (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey
    )
      return;
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!link || link.target || link.hasAttribute('download')) return;
    const url = new URL(link.href, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname.startsWith('/api/')) return;
    event.preventDefault();
    void navigate(url.pathname + url.search);
  });
}

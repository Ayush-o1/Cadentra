import { api, setUnauthorizedHandler } from './api.js';
import { h, mount } from './dom.js';
import { brandMark, icon } from './icons.js';
import { initials } from './format.js';
import { defineRoutes, navigate, setRenderer, show, startRouter } from './router.js';
import { clearSession, loadSession, state } from './state.js';
import { menuButton } from './ui/menu.js';
import { toast } from './ui/toast.js';
import { errorState } from './ui/states.js';
import { loginPage, registerPage } from './pages/auth.js';
import {
  forgotPasswordPage,
  resetPasswordPage,
  verifyEmailPage,
} from './pages/account-recovery.js';
import { dashboardPage } from './pages/dashboard.js';
import { contactsPage } from './pages/contacts.js';
import { listDetailPage, listsPage } from './pages/lists.js';
import { suppressionsPage } from './pages/suppressions.js';
import { campaignsPage } from './pages/campaigns.js';
import { campaignBuilderPage } from './pages/campaign-builder.js';
import { campaignDetailPage } from './pages/campaign-detail.js';
import { analyticsPage } from './pages/analytics.js';
import { settingsPage } from './pages/settings.js';
import { unsubscribePage } from './pages/unsubscribe.js';
import { notFoundPage } from './pages/not-found.js';

const root = document.getElementById('app');

const NAV = [
  { heading: 'Overview' },
  { href: '/', label: 'Dashboard', icon: 'dashboard', exact: true },
  { heading: 'Audience' },
  { href: '/contacts', label: 'Contacts', icon: 'users' },
  { href: '/lists', label: 'Lists', icon: 'list' },
  { href: '/suppressions', label: 'Suppression list', icon: 'ban' },
  { heading: 'Outreach' },
  { href: '/campaigns', label: 'Campaigns', icon: 'mail' },
  { href: '/analytics', label: 'Analytics', icon: 'chart' },
];

defineRoutes([
  { path: '/', page: dashboardPage, title: 'Dashboard' },
  { path: '/contacts', page: contactsPage, title: 'Contacts' },
  { path: '/lists', page: listsPage, title: 'Lists' },
  { path: '/lists/:id', page: listDetailPage, title: 'List' },
  { path: '/suppressions', page: suppressionsPage, title: 'Suppression list' },
  { path: '/campaigns', page: campaignsPage, title: 'Campaigns' },
  { path: '/campaigns/:id', page: campaignDetailPage, title: 'Campaign' },
  { path: '/campaigns/:id/edit', page: campaignBuilderPage, title: 'Edit campaign' },
  { path: '/analytics', page: analyticsPage, title: 'Analytics' },
  { path: '/settings', page: settingsPage, title: 'Settings' },
  { path: '/login', page: loginPage, title: 'Sign in', bare: true, guestOnly: true },
  {
    path: '/register',
    page: registerPage,
    title: 'Create your account',
    bare: true,
    guestOnly: true,
  },
  {
    path: '/forgot-password',
    page: forgotPasswordPage,
    title: 'Reset password',
    bare: true,
    guestOnly: true,
  },
  {
    path: '/reset-password',
    page: resetPasswordPage,
    title: 'Choose a new password',
    bare: true,
    public: true,
  },
  {
    path: '/verify-email',
    page: verifyEmailPage,
    title: 'Confirm email',
    bare: true,
    public: true,
  },
  { path: '/u/:token', page: unsubscribePage, title: 'Unsubscribe', bare: true, public: true },
]);

let shell = null;

function buildShell() {
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Primary' });
  const scrim = h('div', { class: 'scrim', hidden: true, onClick: () => toggleSidebar(false) });
  const main = h('main', { class: 'main', id: 'main', tabindex: '-1' });

  const toggleSidebar = (open) => {
    sidebar.classList.toggle('open', open);
    scrim.hidden = !open;
    menuToggle.setAttribute('aria-expanded', String(open));
  };

  const menuToggle = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-quiet btn-icon',
      'aria-label': 'Open navigation',
      'aria-expanded': 'false',
      'aria-controls': 'sidebar',
      onClick: () => toggleSidebar(true),
    },
    icon('menu'),
  );

  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': 'Main' },
    NAV.map((item) =>
      item.heading
        ? h('div', { class: 'nav-heading' }, item.heading)
        : h(
            'a',
            {
              class: 'nav-item',
              href: item.href,
              'data-nav': item.href,
              'data-exact': item.exact ? 'true' : null,
              onClick: () => toggleSidebar(false),
            },
            icon(item.icon),
            item.label,
          ),
    ),
  );

  const userMenu = menuButton({
    label: 'Account menu',
    buttonClass: 'user-button',
    align: 'left',
    dropUp: true,
    trigger: h(
      'span',
      { class: 'row' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(state.user.name)),
      h(
        'span',
        { class: 'who' },
        h('strong', null, state.user.name),
        h('span', null, state.user.email),
      ),
      icon('chevron-down'),
    ),
    items: [
      { label: 'Settings', icon: 'settings', href: '/settings' },
      'separator',
      { label: 'Sign out', icon: 'logout', onSelect: signOut },
    ],
  });

  sidebar.append(
    h('a', { class: 'brand', href: '/' }, brandMark(), 'Cadentra'),
    h('div', { class: 'workspace-chip' }, h('span', null, 'Workspace'), state.workspace.name),
    nav,
    h('div', { class: 'sidebar-footer' }, userMenu),
  );

  const topbar = h(
    'header',
    { class: 'topbar' },
    menuToggle,
    h('a', { class: 'brand', href: '/' }, brandMark(), 'Cadentra'),
  );
  const el = h('div', { class: 'app' }, sidebar, h('div', null, topbar, main), scrim);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sidebar.classList.contains('open')) toggleSidebar(false);
  });
  return { el, main, nav };
}

function markActiveNav(path) {
  if (!shell) return;
  for (const link of shell.nav.querySelectorAll('[data-nav]')) {
    const href = link.getAttribute('data-nav');
    const active = link.hasAttribute('data-exact')
      ? path === href
      : path === href || path.startsWith(`${href}/`);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

async function signOut() {
  try {
    await api.post('/auth/logout');
  } finally {
    clearSession();
    shell = null;
    await navigate('/login', { replace: true });
  }
}

setUnauthorizedHandler(() => {
  if (!state.user) return;
  clearSession();
  shell = null;
  toast('Your session has ended. Sign in again to continue.', { tone: 'info' });
  void navigate(`/login?next=${encodeURIComponent(window.location.pathname)}`, { replace: true });
});

setRenderer(async (matched, url, isCurrent) => {
  if (!matched) {
    if (!state.user) return navigate('/login', { replace: true });
    ensureShell();
    markActiveNav('');
    document.title = 'Not found · Cadentra';
    return notFoundPage({ container: shell.main });
  }

  const { route, params } = matched;
  if (!route.public) {
    if (!state.user && !route.guestOnly) {
      return navigate(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, {
        replace: true,
      });
    }
    if (state.user && route.guestOnly) return navigate('/', { replace: true });
  }

  document.title = `${route.title} · Cadentra`;
  const ctx = { params, query: url.searchParams, isCurrent, navigate };

  if (route.bare || !state.user) {
    shell = null;
    const container = h('div', { id: 'main', tabindex: '-1' });
    mount(root, container);
    return route.page({ ...ctx, container });
  }

  ensureShell();
  markActiveNav(url.pathname);
  shell.main.replaceChildren();
  const page = h('div', { class: 'page' });
  shell.main.append(page);
  try {
    return await route.page({ ...ctx, container: page });
  } catch (error) {
    if (isCurrent())
      mount(
        page,
        errorState(error, () => void show()),
      );
    return null;
  }
});

function ensureShell() {
  if (!shell) {
    shell = buildShell();
    mount(root, shell.el);
  }
}

async function boot() {
  startRouter();
  try {
    await loadSession();
  } catch (error) {
    mount(
      root,
      h(
        'div',
        { class: 'center-card' },
        errorState(error, () => window.location.reload()),
      ),
    );
    return;
  }
  await show();
}

void boot();

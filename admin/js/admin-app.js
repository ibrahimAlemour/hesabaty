// نقطة دخول لوحة المدير العام: التوجيه (Router) والهيكل العام
import { ensureClient } from './admin-db.js';
import { isAdminLoggedIn, adminSignOut } from './admin-auth.js';
import { renderAdminLogin } from './admin-login.js';
import { renderAdminDashboard } from './admin-dashboard.js';
import { renderShopsList, renderShopDetail } from './admin-shops.js';
import { renderAdminSettings } from './admin-settings.js';
import { toastError } from '../../js/ui.js';

const appContent = document.getElementById('app-content');
const headerTitle = document.getElementById('header-title');
const backBtn = document.getElementById('back-btn');

const NAV_ITEMS = [
  { path: '#/dashboard', label: 'الرئيسية', icon: 'home' },
  { path: '#/shops', label: 'المحلات', icon: 'shops' },
  { path: '#/settings', label: 'الإعدادات', icon: 'settings' }
];

const ROUTES = [
  { pattern: /^#\/dashboard$/, title: 'لوحة المدير العام', render: () => renderAdminDashboard(appContent) },
  { pattern: /^#\/shops$/, title: 'المحلات', render: () => renderShopsList(appContent) },
  { pattern: /^#\/shops\/([\w-]+)$/, title: 'تفاصيل المحل', showBack: true, render: (m) => renderShopDetail(appContent, m[1]) },
  { pattern: /^#\/settings$/, title: 'الإعدادات', render: () => renderAdminSettings(appContent) }
];

function iconSvg(name) {
  const paths = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    shops: '<path d="M3 9l1-5h16l1 5"/><path d="M4 9v10h16V9"/><path d="M9 21v-6h6v6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1.04 1.56V21a2 2 0 11-4 0v-.09A1.7 1.7 0 009 19.36a1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.64 15a1.7 1.7 0 00-1.56-1.04H3a2 2 0 110-4h.09A1.7 1.7 0 004.64 9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 009 4.64a1.7 1.7 0 001.04-1.56V3a2 2 0 114 0v.09a1.7 1.7 0 001.04 1.56 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.36 9c.36.15.68.39.95.7"/>'
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
}

function buildNav() {
  const nav = document.getElementById('bottom-nav');
  nav.innerHTML = NAV_ITEMS.map(item => `<a href="${item.path}">${iconSvg(item.icon)}<span>${item.label}</span></a>`).join('');
  const sidebar = document.getElementById('desktop-sidebar-links');
  if (sidebar) sidebar.innerHTML = NAV_ITEMS.map(item => `<a href="${item.path}">${iconSvg(item.icon)}<span>${item.label}</span></a>`).join('');
}

function updateActiveNav() {
  const hash = window.location.hash || '#/dashboard';
  document.querySelectorAll('.bottom-nav a, .desktop-sidebar a').forEach(a => {
    const href = a.getAttribute('href');
    a.classList.toggle('active', href === hash || (hash.startsWith('#/shops') && href === '#/shops'));
  });
}

async function router() {
  let hash = window.location.hash;
  if (!hash || hash === '#/' || hash === '#') hash = '#/dashboard';

  try { await ensureClient(); } catch (e) { console.error('تعذر تهيئة اتصال Supabase', e); }

  const loggedIn = await isAdminLoggedIn();
  if (!loggedIn) {
    document.getElementById('app-shell').style.display = 'none';
    await renderAdminLogin(document.getElementById('login-root'));
    return;
  }
  document.getElementById('app-shell').style.display = '';
  document.getElementById('login-root').innerHTML = '';

  for (const route of ROUTES) {
    const m = hash.match(route.pattern);
    if (m) {
      headerTitle.textContent = route.title;
      backBtn.style.display = route.showBack ? 'flex' : 'none';
      try {
        await route.render(m);
      } catch (err) {
        console.error(err);
        toastError('حدث خطأ أثناء تحميل الصفحة. حاول مرة أخرى.');
      }
      updateActiveNav();
      window.scrollTo(0, 0);
      return;
    }
  }
  window.location.hash = '#/dashboard';
}

backBtn.addEventListener('click', () => window.history.back());
window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', () => {
  buildNav();
  router();
  const logoutHandler = async () => { await adminSignOut(); window.location.reload(); };
  document.getElementById('sidebar-logout').onclick = logoutHandler;
  document.getElementById('mobile-logout').onclick = logoutHandler;
});

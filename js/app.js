// نقطة الدخول: التوجيه (Router) وهيكل الصفحة العام
import { getSettings } from './database.js';
import { isLoggedIn, getCurrentUser } from './auth.js';
import { initAutoSync } from './sync.js';
import { toastError } from './ui.js';
import { renderSetupWizard } from './setup.js';
import { renderLogin } from './login.js';
import { renderDashboard } from './dashboard.js';
import { renderNewSale, renderEditSale } from './sales.js';
import { renderCustomerList, renderCustomerDetail } from './customers.js';
import { renderProductList } from './products.js';
import { renderTransfers } from './transfers.js';
import { renderExpenses } from './expenses.js';
import { renderCash } from './cash.js';
import { renderReports } from './reports.js';
import { renderSettings, applyTheme } from './settings.js';
import { renderInvoice } from './invoice.js';
import { renderDebts } from './debts.js';

const appContent = document.getElementById('app-content');
const headerTitle = document.getElementById('header-title');
const backBtn = document.getElementById('back-btn');

const NAV_ITEMS = [
  { path: '#/dashboard', label: 'الرئيسية', icon: 'home' },
  { path: '#/customers', label: 'الزبائن', icon: 'users' },
  { path: '#/sale/new', label: 'بيع', icon: 'plus', isFab: true },
  { path: '#/reports', label: 'التقارير', icon: 'chart' },
  { path: '#/more', label: 'المزيد', icon: 'menu' }
];

const MORE_ITEMS = [
  { path: '#/products', label: 'المنتجات', icon: '📦' },
  { path: '#/debts', label: 'الديون', icon: '💳' },
  { path: '#/transfers', label: 'التحويلات', icon: '📱' },
  { path: '#/expenses', label: 'المصروفات', icon: '💸' },
  { path: '#/cash', label: 'الصندوق', icon: '💰' },
  { path: '#/settings', label: 'الإعدادات', icon: '⚙️' }
];

const ROUTES = [
  { pattern: /^#\/dashboard$/, title: 'حساباتي', render: () => renderDashboard(appContent) },
  { pattern: /^#\/sale\/new$/, title: 'بيع جديد', showBack: true, render: () => renderNewSale(appContent) },
  { pattern: /^#\/sale\/edit\/([\w-]+)$/, title: 'تعديل الفاتورة', showBack: true, render: (m) => renderEditSale(appContent, m[1]) },
  { pattern: /^#\/customers$/, title: 'الزبائن', render: () => renderCustomerList(appContent) },
  { pattern: /^#\/customers\/([\w-]+)$/, title: 'حساب الزبون', showBack: true, render: (m) => renderCustomerDetail(appContent, m[1]) },
  { pattern: /^#\/products$/, title: 'المنتجات', showBack: true, render: () => renderProductList(appContent) },
  { pattern: /^#\/debts$/, title: 'الديون', showBack: true, render: () => renderDebts(appContent) },
  { pattern: /^#\/transfers$/, title: 'التحويلات', showBack: true, render: () => renderTransfers(appContent) },
  { pattern: /^#\/expenses$/, title: 'المصروفات', showBack: true, render: () => renderExpenses(appContent) },
  { pattern: /^#\/cash$/, title: 'الصندوق', showBack: true, render: () => renderCash(appContent) },
  { pattern: /^#\/reports$/, title: 'التقارير', render: () => renderReports(appContent) },
  { pattern: /^#\/settings$/, title: 'الإعدادات', showBack: true, render: () => renderSettings(appContent) },
  { pattern: /^#\/invoice\/([\w-]+)$/, title: 'الفاتورة', showBack: true, render: (m) => renderInvoice(appContent, m[1]) },
  { pattern: /^#\/more$/, title: 'المزيد', render: () => renderMore(appContent) }
];

function renderMore(container) {
  container.innerHTML = `
    <div class="card" style="padding:6px;">
      <ul>
        ${MORE_ITEMS.map(i => `
          <li class="list-item" style="cursor:pointer;" data-nav="${i.path}">
            <div class="avatar" style="background:var(--bg);font-size:19px;">${i.icon}</div>
            <div class="info"><div class="title">${i.label}</div></div>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-muted)"><path d="M9 6l6 6-6 6"/></svg>
          </li>`).join('')}
      </ul>
    </div>`;
  container.querySelectorAll('[data-nav]').forEach(el => el.onclick = () => navigate(el.dataset.nav));
}

export function navigate(path) { window.location.hash = path; }

function updateActiveNav() {
  const hash = window.location.hash || '#/dashboard';
  document.querySelectorAll('.bottom-nav a, .desktop-sidebar a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === hash || (hash.startsWith('#/customers') && a.getAttribute('href') === '#/customers'));
  });
}

async function router() {
  let hash = window.location.hash;
  if (!hash || hash === '#/' || hash === '#') hash = '#/dashboard';

  const loggedIn = await isLoggedIn();
  const settings = await getSettings();
  applyTheme(settings.theme || 'auto');

  if (!settings.setupCompleted) {
    document.getElementById('app-shell').style.display = 'none';
    renderSetupWizard(document.getElementById('setup-root'));
    return;
  }
  if (!loggedIn) {
    document.getElementById('app-shell').style.display = 'none';
    document.getElementById('setup-root').innerHTML = '';
    renderLogin(document.getElementById('login-root'));
    return;
  }
  document.getElementById('app-shell').style.display = '';
  document.getElementById('login-root').innerHTML = '';
  document.getElementById('setup-root').innerHTML = '';

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
  navigate('#/dashboard');
}

backBtn.addEventListener('click', () => window.history.back());
window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', () => {
  buildNav();
  router();
  initAutoSync();
});

function iconSvg(name) {
  const paths = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M2 20c0-3.3 3-6 7-6s7 2.7 7 6"/><circle cx="17" cy="9" r="2.3"/><path d="M15.5 14c2.8.3 5 2.4 5 6"/>',
    chart: '<path d="M4 20V10M12 20V4M20 20v-7"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>'
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${paths[name] || ''}</svg>`;
}

function buildNav() {
  const nav = document.getElementById('bottom-nav');
  nav.innerHTML = NAV_ITEMS.map(item => {
    if (item.isFab) {
      return `<a href="${item.path}" class="nav-fab"><span class="nav-fab-btn">${iconSvg('plus')}</span></a>`;
    }
    return `<a href="${item.path}">${iconSvg(item.icon)}<span>${item.label}</span></a>`;
  }).join('');

  const sidebar = document.getElementById('desktop-sidebar-links');
  if (sidebar) {
    sidebar.innerHTML = [...NAV_ITEMS.filter(i => !i.isFab), ...MORE_ITEMS.map(i => ({ path: i.path, label: i.label, icon: null, emoji: i.icon }))]
      .map(item => `<a href="${item.path}">${item.icon ? iconSvg(item.icon) : `<span style="width:19px;text-align:center;">${item.emoji}</span>`}<span>${item.label}</span></a>`).join('');
  }
}

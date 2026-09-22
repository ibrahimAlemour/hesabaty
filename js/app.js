// نقطة الدخول: التوجيه (Router) وهيكل الصفحة العام
import { getSettings, updateSettings, pullFromRemote } from './database.js';
import { isLoggedIn, getCurrentUser, refreshShopStatus, signOut } from './auth.js';
import { initAutoSync, flushQueue, onSyncStatusChange, getSyncStatus, getPendingIds } from './sync.js';
import * as remoteDb from './db-supabase.js';
import { toastError } from './ui.js';
import { renderSetupWizard } from './setup.js';
import { renderLogin } from './login.js';
import { renderDashboard } from './dashboard.js';
import { renderNewSale, renderEditSale } from './sales.js';
import { renderCustomerList, renderCustomerDetail } from './customers.js';
import { renderProductList } from './products.js';
import { renderInventory } from './inventory.js';
import { renderCategories } from './categories.js';
import { renderTransfers } from './transfers.js';
import { renderExpenses } from './expenses.js';
import { renderCash } from './cash.js';
import { renderReports } from './reports.js';
import { renderSettings, applyTheme } from './settings.js';
import { renderInvoice } from './invoice.js';
import { renderDebts } from './debts.js';
import './pwa-install.js';

const appContent = document.getElementById('app-content');
const headerTitle = document.getElementById('header-title');
const backBtn = document.getElementById('back-btn');
let hasPulledThisSession = false;

const NAV_ITEMS = [
  { path: '#/dashboard', label: 'الرئيسية', icon: 'home' },
  { path: '#/customers', label: 'الزبائن', icon: 'users' },
  { path: '#/sale/new', label: 'بيع', icon: 'plus', isFab: true },
  { path: '#/reports', label: 'التقارير', icon: 'chart' },
  { path: '#/more', label: 'المزيد', icon: 'menu' }
];

const MORE_ITEMS = [
  { path: '#/products', label: 'المنتجات', icon: '📦' },
  { path: '#/inventory', label: 'المخزون', icon: '📋' },
  { path: '#/categories', label: 'التصنيفات', icon: '🏷️' },
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
  { pattern: /^#\/inventory$/, title: 'المخزون', showBack: true, render: () => renderInventory(appContent) },
  { pattern: /^#\/categories$/, title: 'التصنيفات', showBack: true, render: () => renderCategories(appContent) },
  { pattern: /^#\/debts$/, title: 'الديون', showBack: true, render: () => renderDebts(appContent) },
  { pattern: /^#\/transfers$/, title: 'التحويلات', showBack: true, render: () => renderTransfers(appContent) },
  { pattern: /^#\/expenses$/, title: 'المصروفات', showBack: true, render: () => renderExpenses(appContent) },
  { pattern: /^#\/cash$/, title: 'الصندوق', showBack: true, render: () => renderCash(appContent) },
  { pattern: /^#\/reports$/, title: 'التقارير', render: () => renderReports(appContent) },
  { pattern: /^#\/settings$/, title: 'الإعدادات', showBack: true, render: () => renderSettings(appContent) },
  { pattern: /^#\/invoice\/([\w-]+)$/, title: 'الفاتورة', showBack: true, render: (m) => renderInvoice(appContent, m[1]) },
  { pattern: /^#\/more$/, title: 'المزيد', render: () => renderMore(appContent) }
];

async function renderSuspendedScreen(container) {
  container.style.display = '';
  let message = 'انتهى اشتراكك. للتجديد تواصل معنا.';
  try {
    const adminSettings = await remoteDb.getAdminSettings();
    if (adminSettings && adminSettings.contact_message) message = adminSettings.contact_message;
  } catch (e) { /* استخدم الرسالة الافتراضية إن تعذر الجلب */ }

  container.innerHTML = `
    <div class="setup-wizard" style="justify-content:center;text-align:center;">
      <div style="font-size:52px;">🔒</div>
      <h2 style="margin:10px 0 6px;">الحساب معلّق مؤقتًا</h2>
      <p style="color:var(--text-muted);font-size:14.5px;line-height:1.8;margin-bottom:20px;">${message.replace(/</g, '&lt;')}</p>
      <p style="color:var(--text-muted);font-size:12.5px;">بياناتك وفواتيرك وديونك محفوظة بالكامل ولن تُحذف.</p>
      <button class="btn btn-secondary btn-block" id="suspended-logout" style="margin-top:20px;">تسجيل الخروج</button>
    </div>`;
  container.querySelector('#suspended-logout').onclick = async () => {
    await signOut();
    window.location.reload();
  };
}

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

  const settings = await getSettings();
  applyTheme(settings.theme || 'auto');

  if (!settings.setupCompleted) {
    document.getElementById('app-shell').style.display = 'none';
    renderSetupWizard(document.getElementById('setup-root'));
    return;
  }

  if (settings.backendMode === 'supabase' && !remoteDb.getClient()) {
    try {
      await remoteDb.loadSupabaseScript();
      await remoteDb.initSupabaseClient({ url: settings.supabaseUrl, anonKey: settings.supabaseAnonKey });
      flushQueue();
    } catch (e) {
      console.error('تعذر تهيئة اتصال Supabase', e);
    }
  }

  const loggedIn = await isLoggedIn();
  if (!loggedIn) {
    document.getElementById('app-shell').style.display = 'none';
    document.getElementById('setup-root').innerHTML = '';
    renderLogin(document.getElementById('login-root'));
    return;
  }

  if (settings.backendMode === 'supabase') {
    const status = await refreshShopStatus();
    if (status === 'suspended') {
      document.getElementById('app-shell').style.display = 'none';
      document.getElementById('setup-root').innerHTML = '';
      await renderSuspendedScreen(document.getElementById('login-root'));
      return;
    }
  }

  document.getElementById('app-shell').style.display = '';
  document.getElementById('login-root').innerHTML = '';
  document.getElementById('setup-root').innerHTML = '';

  // ننتظر أول مزامنة بعد الدخول قبل عرض أي شاشة، حتى لا تظهر بيانات افتراضية قديمة (اسم المحل مثلاً)
  // قبل أن تصل البيانات الحقيقية من سوبابيس
  if (settings.backendMode === 'supabase' && !hasPulledThisSession) {
    appContent.innerHTML = `<div style="text-align:center;padding:60px 16px;color:var(--text-muted);">
      <div class="loading-spinner" style="border-top-color:var(--primary);width:26px;height:26px;"></div>
      <p style="margin-top:14px;">جاري تحميل بيانات محلك...</p>
    </div>`;
    hasPulledThisSession = true;
    try { await pullFromRemote(); } catch (e) { console.error('تعذر سحب البيانات من سوبابيس', e); }
  }

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

const SYNC_ICON_TITLES = {
  offline: 'غير متصل - العمليات محفوظة على الجهاز وسترفع تلقائيًا عند عودة الإنترنت',
  pending: 'بانتظار المزامنة مع الخادم',
  syncing: 'جاري المزامنة...',
  synced: 'متصل ومتزامن بالكامل'
};

async function applySyncIconStatus(status) {
  const btn = document.getElementById('sync-status-btn');
  if (!btn) return;
  btn.classList.remove('sync-offline', 'sync-pending', 'sync-syncing', 'sync-synced');
  btn.classList.add(`sync-${status}`);

  // نعرض عدد عمليات البيع غير المتزامنة تحديدًا (لا العدد الخام لعناصر طابور المزامنة، لأن كل عملية بيع
  // واحدة تُسجَّل داخليًا كعدة عناصر منفصلة: الفاتورة نفسها + أصنافها + حركة الصندوق + سجل التدقيق)
  const pending = (await getPendingIds('sales')).size;
  const badge = document.getElementById('sync-pending-badge');
  if (badge) {
    if (pending > 0) { badge.textContent = pending > 99 ? '99+' : String(pending); badge.style.display = ''; }
    else badge.style.display = 'none';
  }
  const suffix = pending > 0 ? ` (${pending} عملية بيع بانتظار الرفع)` : '';
  btn.title = (SYNC_ICON_TITLES[status] || '') + suffix;
}

async function initSyncIndicator() {
  const settings = await getSettings();
  const btn = document.getElementById('sync-status-btn');
  if (!btn) return;
  if (settings.backendMode !== 'supabase') { btn.style.display = 'none'; return; }
  applySyncIconStatus(await getSyncStatus());
  onSyncStatusChange(applySyncIconStatus);
}

backBtn.addEventListener('click', () => window.history.back());
window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', () => {
  buildNav();
  router();
  initAutoSync();
  initSyncIndicator();
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

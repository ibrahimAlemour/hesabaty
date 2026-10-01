// واجهة كاشير مبسّطة (مؤقتة): شاشة رئيسية مختصرة + عرض فقط لحسابات الزبائن والتجار، بدون أي إجراء مالي أو إداري
// منفصلة تمامًا عن customers.js/suppliers.js عمدًا حتى لا تتأثر واجهة المالك إطلاقًا بهذا التعديل المؤقت
import * as db from './database.js';
import { getCurrentUser, signOut } from './auth.js';
import { formatMoney, formatDateTime, formatDate, escapeHtml, fuzzyMatch, debounce } from './utils.js';
import { confirmDialog, emptyState } from './ui.js';

const LIST_LIMIT = 80;

export async function renderCashierHome(container) {
  const user = await getCurrentUser();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'صباح الخير' : 'مساء الخير';

  container.innerHTML = `
    <div style="text-align:center;padding:26px 0 6px;">
      <div style="font-size:14.5px;color:var(--text-muted);">${greeting}</div>
      <div style="font-size:21px;font-weight:800;margin-top:2px;">${escapeHtml(user?.name || '')} 👋</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:36px;">
      <div data-nav="#/customers" style="background:var(--surface);border-radius:18px;box-shadow:var(--shadow);padding:32px 10px;display:flex;flex-direction:column;align-items:center;gap:10px;cursor:pointer;">
        <div style="font-size:40px;">👥</div>
        <div style="font-weight:800;font-size:15px;">الزبائن</div>
      </div>
      <div data-nav="#/suppliers" style="background:var(--surface);border-radius:18px;box-shadow:var(--shadow);padding:32px 10px;display:flex;flex-direction:column;align-items:center;gap:10px;cursor:pointer;">
        <div style="font-size:40px;">🚚</div>
        <div style="font-weight:800;font-size:15px;">التجار</div>
      </div>
    </div>
    <button class="btn btn-outline btn-block" id="cashier-logout" style="margin-top:40px;">تسجيل الخروج</button>
  `;

  container.querySelectorAll('[data-nav]').forEach(el => el.onclick = () => { window.location.hash = el.dataset.nav; });
  container.querySelector('#cashier-logout').onclick = async () => {
    const ok = await confirmDialog({ title: 'تسجيل الخروج', message: 'هل تريد تسجيل الخروج؟', danger: false, confirmLabel: 'خروج' });
    if (!ok) return;
    await signOut();
    window.location.reload();
  };
}

// ---------- الزبائن (عرض فقط) ----------

export async function renderCashierCustomerList(container) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const customers = await db.getCustomersWithBalance();
  renderCustomerListView(container, customers, '');
}

function renderCustomerListView(container, customers, query) {
  const filtered = query ? customers.filter(c => fuzzyMatch(c.name, query) || (c.phone && c.phone.includes(query))) : customers;
  const monthlyCount = customers.filter(c => c.payment_cycle === 'monthly').length;
  const weeklyCount = customers.filter(c => c.payment_cycle === 'weekly').length;
  container.innerHTML = `
    <div style="display:flex;gap:10px;margin-bottom:14px;">
      <div class="stat-card" style="flex:1;align-items:center;text-align:center;">
        <div class="stat-label">👥 الكل</div>
        <div class="stat-value">${customers.length}</div>
      </div>
      <div class="stat-card" style="flex:1;align-items:center;text-align:center;">
        <div class="stat-label">🗓️ شهري</div>
        <div class="stat-value">${monthlyCount}</div>
      </div>
      <div class="stat-card" style="flex:1;align-items:center;text-align:center;">
        <div class="stat-label">🗓️ أسبوعي</div>
        <div class="stat-value">${weeklyCount}</div>
      </div>
    </div>
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input type="text" id="cashier-customer-search" placeholder="ابحث بالاسم أو الهاتف..." value="${escapeHtml(query)}">
    </div>
    <div class="card" style="padding:6px 10px;">
      ${filtered.length ? filtered.map(cashierCustomerRow).join('') : emptyState('👥', 'لا يوجد زبائن')}
    </div>
  `;
  container.querySelector('#cashier-customer-search').oninput = debounce((e) => renderCustomerListView(container, customers, e.target.value), 150);
  container.querySelector('#cashier-customer-search').focus();
  container.querySelector('#cashier-customer-search').setSelectionRange(query.length, query.length);
  container.querySelectorAll('[data-open]').forEach(el => el.onclick = () => { window.location.hash = `#/customers/${el.dataset.open}`; });
}

function cashierCycleBadge(customer) {
  const cycle = customer.payment_cycle && db.PAYMENT_CYCLES[customer.payment_cycle];
  return cycle ? `<span class="badge" style="background:var(--blue-light);color:var(--blue);margin-right:6px;">🗓️ ${cycle.label}</span>` : '';
}

function cashierCustomerRow(c) {
  return `
    <div class="list-item" style="cursor:pointer;" data-open="${c.id}">
      <div class="avatar">${escapeHtml(c.name[0])}</div>
      <div class="info">
        <div class="title">${escapeHtml(c.name)} ${cashierCycleBadge(c)}</div>
        <div class="subtitle">${c.phone || 'بدون رقم هاتف'}</div>
      </div>
      <div style="text-align:left;">
        <div class="amount" style="${c.balance > 0 ? 'color:var(--danger);' : c.balance < 0 ? 'color:var(--success);' : ''}">${c.balance !== 0 ? formatMoney(Math.abs(c.balance)) : '—'}</div>
        <div class="meta">${c.balance > 0 ? 'عليه' : c.balance < 0 ? 'له رصيد' : 'لا يوجد رصيد'}</div>
      </div>
    </div>`;
}

export async function renderCashierCustomerDetail(container, customerId) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const [customer, balance, ledger] = await Promise.all([
    db.getCustomer(customerId), db.getCustomerBalance(customerId), db.getCustomerLedger(customerId)
  ]);
  if (!customer) { container.innerHTML = `<div class="card">الزبون غير موجود</div>`; return; }
  const dueDate = await db.getExpectedDueDate(customer, balance);
  const overdue = dueDate && new Date(dueDate) < new Date();

  container.innerHTML = `
    <div class="card">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        <div class="avatar" style="width:48px;height:48px;font-size:18px;">${escapeHtml(customer.name[0])}</div>
        <div>
          <div style="font-weight:800;font-size:16px;">${escapeHtml(customer.name)}</div>
          <div style="font-size:12.5px;color:var(--text-muted);">${customer.phone || 'بدون رقم هاتف'}</div>
        </div>
      </div>
      <div class="balance-hero">
        <div class="amount" style="${balance > 0 ? 'color:var(--danger);' : balance < 0 ? 'color:var(--success);' : 'color:var(--text-muted);'}">${formatMoney(Math.abs(balance))}</div>
        <div class="label">${balance > 0 ? 'الرصيد المستحق على الزبون' : balance < 0 ? 'له رصيد (دفع مسبقًا أكثر من المطلوب)' : 'لا يوجد رصيد مستحق'}</div>
        ${dueDate ? `<div class="label" style="${overdue ? 'color:var(--danger);font-weight:700;' : ''}margin-top:4px;">${overdue ? '⚠️ تجاوز موعد السداد المتوقع' : 'موعد السداد المتوقع'}: ${formatDate(dueDate)}</div>` : ''}
      </div>
    </div>
    <div class="card" style="padding:10px;">
      <div style="font-weight:800;font-size:14px;margin-bottom:6px;">سجل الحركات</div>
      ${ledger.length ? ledger.slice(0, LIST_LIMIT).map(cashierLedgerRow).join('') : emptyState('📋', 'لا توجد حركات بعد')}
    </div>
  `;
}

function cashierLedgerRow(entry) {
  const isDebt = entry.direction === 'debt';
  return `
    <div class="list-item">
      <div class="avatar" style="background:${isDebt ? 'var(--danger-light)' : 'var(--success-light)'};color:${isDebt ? 'var(--danger)' : 'var(--success)'};">${isDebt ? '📝' : '💵'}</div>
      <div class="info">
        <div class="title">${escapeHtml(entry.label)}</div>
        <div class="subtitle">${formatDateTime(entry.date)}</div>
      </div>
      <div class="amount ${isDebt ? 'debt' : 'cash'}">${isDebt ? '+' : '-'}${formatMoney(entry.amount)}</div>
    </div>`;
}

// ---------- التجار/الموردون (عرض فقط) ----------

export async function renderCashierSupplierList(container) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const suppliers = await db.getSuppliersWithBalance();
  renderSupplierListView(container, suppliers, '');
}

function renderSupplierListView(container, suppliers, query) {
  const filtered = query ? suppliers.filter(s => fuzzyMatch(s.name, query) || (s.phone && s.phone.includes(query))) : suppliers;
  container.innerHTML = `
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input type="text" id="cashier-supplier-search" placeholder="ابحث بالاسم أو الهاتف..." value="${escapeHtml(query)}">
    </div>
    <div class="card" style="padding:6px 10px;">
      ${filtered.length ? filtered.map(cashierSupplierRow).join('') : emptyState('🚚', 'لا يوجد تجار')}
    </div>
  `;
  container.querySelector('#cashier-supplier-search').oninput = debounce((e) => renderSupplierListView(container, suppliers, e.target.value), 150);
  container.querySelector('#cashier-supplier-search').focus();
  container.querySelector('#cashier-supplier-search').setSelectionRange(query.length, query.length);
  container.querySelectorAll('[data-open]').forEach(el => el.onclick = () => { window.location.hash = `#/suppliers/${el.dataset.open}`; });
}

function cashierSupplierRow(s) {
  return `
    <div class="list-item" style="cursor:pointer;" data-open="${s.id}">
      <div class="avatar">${escapeHtml(s.name[0])}</div>
      <div class="info">
        <div class="title">${escapeHtml(s.name)}</div>
        <div class="subtitle">${s.phone || 'بدون رقم هاتف'}</div>
        ${s.lastInvoiceDate ? `<div class="meta">آخر فاتورة: ${formatDate(s.lastInvoiceDate)}</div>` : ''}
      </div>
      <div style="text-align:left;">
        <div class="amount" style="${s.balance > 0 ? 'color:var(--danger);' : ''}">${s.balance > 0 ? formatMoney(s.balance) : '—'}</div>
        <div class="meta">${s.balance > 0 ? 'مستحق له' : 'لا يوجد رصيد'}</div>
      </div>
    </div>`;
}

export async function renderCashierSupplierDetail(container, supplierId) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const [supplier, balance, purchases, ledger] = await Promise.all([
    db.getSupplier(supplierId), db.getSupplierBalance(supplierId), db.getPurchases({ supplierId }), db.getSupplierLedger(supplierId)
  ]);
  if (!supplier) { container.innerHTML = `<div class="card">المورد غير موجود</div>`; return; }
  const totalPurchases = purchases.reduce((s, p) => s + (p.total_amount || 0), 0);

  container.innerHTML = `
    <div class="card">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        <div class="avatar" style="width:48px;height:48px;font-size:18px;">${escapeHtml(supplier.name[0])}</div>
        <div>
          <div style="font-weight:800;font-size:16px;">${escapeHtml(supplier.name)}</div>
          <div style="font-size:12.5px;color:var(--text-muted);">${supplier.phone || 'بدون رقم هاتف'}</div>
        </div>
      </div>
      <div class="balance-hero">
        <div class="amount" style="${balance > 0 ? 'color:var(--danger);' : 'color:var(--text-muted);'}">${formatMoney(Math.abs(balance))}</div>
        <div class="label">${balance > 0 ? 'المستحق لهذا التاجر' : 'لا يوجد رصيد مستحق'}</div>
      </div>
      <div style="display:flex;gap:10px;justify-content:center;font-size:12.5px;color:var(--text-muted);margin-bottom:14px;">
        <span>إجمالي المشتريات: <b style="color:var(--text);">${formatMoney(totalPurchases)}</b></span>
      </div>
      <button class="btn btn-outline btn-block" id="cashier-statement-btn">📄 كشف حساب</button>
    </div>
    <div class="card" style="padding:10px;">
      <div class="seg-tabs">
        <button class="seg-tab active" data-tab="invoices">فواتير الشراء</button>
        <button class="seg-tab" data-tab="ledger">سجل الحركات</button>
      </div>
      <div id="cashier-tab-content"></div>
    </div>
  `;

  function invoiceRow(p) {
    const statusBadge = { paid: '<span class="badge cash">مدفوعة</span>', partial: '<span class="badge partial">جزئي</span>', credit: '<span class="badge debt">آجل</span>' }[p.payment_status] || '';
    return `
      <div class="list-item" style="cursor:pointer;" data-invoice-open="${p.id}">
        <div class="avatar">🧾</div>
        <div class="info">
          <div class="title">${escapeHtml(p.purchase_number)}</div>
          <div class="subtitle">${formatDateTime(p.created_at)}</div>
        </div>
        <div style="text-align:left;display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
          <div class="amount">${formatMoney(p.total_amount)}</div>
          ${statusBadge}
        </div>
      </div>`;
  }

  function ledgerRow(entry) {
    const isDebt = entry.direction === 'debt';
    return `
      <div class="list-item">
        <div class="avatar" style="background:${isDebt ? 'var(--danger-light)' : 'var(--success-light)'};color:${isDebt ? 'var(--danger)' : 'var(--success)'};">${isDebt ? '📝' : '💵'}</div>
        <div class="info">
          <div class="title">${escapeHtml(entry.label)}</div>
          <div class="subtitle">${formatDateTime(entry.date)}</div>
        </div>
        <div class="amount ${isDebt ? 'debt' : 'cash'}">${isDebt ? '+' : '-'}${formatMoney(entry.amount)}</div>
      </div>`;
  }

  function renderTab(tab) {
    const el = container.querySelector('#cashier-tab-content');
    if (tab === 'invoices') {
      el.innerHTML = purchases.length ? purchases.slice(0, LIST_LIMIT).map(invoiceRow).join('') : emptyState('🧾', 'لا توجد فواتير شراء بعد');
      el.querySelectorAll('[data-invoice-open]').forEach(b => b.onclick = () => { window.location.hash = `#/purchase/${b.dataset.invoiceOpen}`; });
    } else {
      el.innerHTML = ledger.length ? ledger.slice(0, LIST_LIMIT).map(ledgerRow).join('') : emptyState('📋', 'لا توجد حركات بعد');
    }
  }

  container.querySelectorAll('.seg-tab').forEach(btn => btn.onclick = () => {
    container.querySelectorAll('.seg-tab').forEach(b => b.classList.toggle('active', b === btn));
    renderTab(btn.dataset.tab);
  });
  renderTab('invoices');

  container.querySelector('#cashier-statement-btn').onclick = () => { window.location.hash = `#/suppliers/${supplier.id}/statement`; };
}

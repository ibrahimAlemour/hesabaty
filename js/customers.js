// شاشات الزبائن: القائمة، إضافة، تفاصيل الحساب، تسجيل دفعة
import * as db from './database.js';
import { canDelete, getCurrentUser } from './auth.js';
import { formatMoney, formatDateTime, formatDate, escapeHtml, fuzzyMatch, debounce, toCents, startOfDay, endOfDay, isValidPhone } from './utils.js';
import { toastError, toastSuccess, setLoading, openSheet, closeSheet, confirmDialog, emptyState } from './ui.js';

export async function renderCustomerList(container) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const customers = await db.getCustomersWithBalance();
  renderList(container, customers, '');
}

// نبني الهيكل الثابت (بطاقات الإحصاء + مربع البحث + زر الإضافة) مرة واحدة فقط عند دخول الشاشة، وعنصر
// input نفسه لا يُعاد إنشاؤه أبدًا بعدها؛ كل ضغطة تُحدّث فقط منطقة النتائج الفرعية (#customer-list-results)
// حتى لا يفقد المتصفح أي حرف أو يفقد التركيز أثناء الكتابة السريعة (كان الهيكل القديم يعيد بناء الحاوية
// كاملة بما فيها input نفسه بكل ضغطة، فيدمّره ويعيد إنشاءه من جديد كل مرة)
function renderList(container, customers, query) {
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
      <input type="text" id="customer-search" placeholder="ابحث بالاسم أو الهاتف..." value="${escapeHtml(query)}">
    </div>
    <button class="btn btn-primary btn-block" id="add-customer-btn" style="margin-bottom:14px;">+ إضافة زبون</button>
    <div class="card" style="padding:6px 10px;" id="customer-list-results"></div>
  `;

  const renderResults = (q) => {
    const filtered = q ? customers.filter(c => fuzzyMatch(c.name, q) || (c.phone && c.phone.includes(q))) : customers;
    const resultsEl = container.querySelector('#customer-list-results');
    resultsEl.innerHTML = filtered.length ? filtered.map(customerRow).join('') : emptyState('👥', 'لا يوجد زبائن', 'أضف أول زبون للبدء');
    resultsEl.querySelectorAll('[data-open]').forEach(el => el.onclick = () => window.location.hash = `#/customers/${el.dataset.open}`);
  };
  renderResults(query);

  container.querySelector('#customer-search').oninput = debounce((e) => renderResults(e.target.value), 150);
  container.querySelector('#add-customer-btn').onclick = () => openAddCustomerSheet(container);
}

function cycleBadge(customer) {
  const cycle = customer.payment_cycle && db.PAYMENT_CYCLES[customer.payment_cycle];
  const cyclePart = cycle ? `<span class="badge" style="background:var(--blue-light);color:var(--blue);margin-right:6px;">🗓️ ${cycle.label}</span>` : '';
  const smsPart = customer.sms_excluded ? `<span class="badge" style="background:var(--border);color:var(--text-muted);margin-right:6px;">🔕 مستثنى من SMS</span>` : '';
  return cyclePart + smsPart;
}

function dueDateNote(c) {
  if (!c.dueDate) return '';
  const overdue = new Date(c.dueDate) < new Date();
  return `<div class="meta" style="${overdue ? 'color:var(--danger);font-weight:700;' : ''}">${overdue ? 'تجاوز موعد السداد' : 'السداد المتوقع'}: ${formatDate(c.dueDate)}</div>`;
}

function customerRow(c) {
  return `
    <div class="list-item" style="cursor:pointer;" data-open="${c.id}">
      <div class="avatar">${escapeHtml(c.name[0])}</div>
      <div class="info">
        <div class="title">${escapeHtml(c.name)} ${cycleBadge(c)}</div>
        <div class="subtitle">${c.phone || 'بدون رقم هاتف'}</div>
        ${dueDateNote(c)}
      </div>
      <div style="text-align:left;">
        <div class="amount" style="${c.balance > 0 ? 'color:var(--danger);' : c.balance < 0 ? 'color:var(--success);' : ''}">${c.balance !== 0 ? formatMoney(Math.abs(c.balance)) : '—'}</div>
        <div class="meta">${c.balance > 0 ? 'عليه' : c.balance < 0 ? 'له رصيد' : 'لا يوجد رصيد'}</div>
      </div>
    </div>`;
}

function openAddCustomerSheet(container, onSaved) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>+ إضافة زبون</h3></div>
    <div class="form-group"><label>الاسم</label><input type="text" id="nc-name" placeholder="اسم الزبون"></div>
    <div class="form-group"><label>رقم الهاتف (اختياري)</label><input type="tel" id="nc-phone" placeholder="05xxxxxxxx"></div>
    <div class="form-group">
      <label>نظام السداد (اختياري)</label>
      <select id="nc-cycle">
        <option value="">بدون تحديد</option>
        <option value="weekly">أسبوعي</option>
        <option value="monthly">شهري</option>
      </select>
      <p class="hint">لتنظيم متابعة الديون وموعد السداد المتوقع لكل زبون</p>
    </div>
    <div class="form-group"><label>ملاحظات (اختياري)</label><textarea id="nc-notes"></textarea></div>
    <button class="btn btn-primary btn-block" id="nc-save">حفظ</button>
  `, { onOpen: (el) => el.querySelector('#nc-name').focus() });

  overlay.querySelector('#nc-save').onclick = async () => {
    const name = overlay.querySelector('#nc-name').value.trim();
    if (!name) return toastError('أدخل اسم الزبون');
    const phone = overlay.querySelector('#nc-phone').value.trim();
    if (!isValidPhone(phone)) return toastError('رقم الجوال يجب أن يكون 10 أرقام فقط');
    const btn = overlay.querySelector('#nc-save');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      const customer = await db.addCustomer({
        name, phone, notes: overlay.querySelector('#nc-notes').value.trim(),
        payment_cycle: overlay.querySelector('#nc-cycle').value || null
      });
      closeSheet();
      toastSuccess('تم إضافة الزبون');
      if (onSaved) onSaved(customer); else renderCustomerList(container);
    } catch (err) {
      toastError('حدث خطأ أثناء حفظ الزبون. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };
}

export async function renderCustomerDetail(container, customerId) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const [customer, balance, ledger, smsLogAll, user] = await Promise.all([
    db.getCustomer(customerId), db.getCustomerBalance(customerId), db.getCustomerLedger(customerId), db.getSmsLog(200), getCurrentUser()
  ]);
  if (!customer) { container.innerHTML = `<div class="card">الزبون غير موجود</div>`; return; }
  const canManage = canDelete(user);
  const dueDate = await db.getExpectedDueDate(customer, balance);
  const overdue = dueDate && new Date(dueDate) < new Date();
  const smsLog = smsLogAll.filter(e => e.customer_id === customerId);
  const smsSent = smsLog.filter(e => e.status === 'sent').length;
  const smsFailed = smsLog.filter(e => e.status === 'failed').length;

  container.innerHTML = `
    <div class="card">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        <div class="avatar" style="width:48px;height:48px;font-size:18px;">${escapeHtml(customer.name[0])}</div>
        <div>
          <div style="font-weight:800;font-size:16px;">${escapeHtml(customer.name)} ${cycleBadge(customer)}</div>
          <div style="font-size:12.5px;color:var(--text-muted);">${customer.phone || 'بدون رقم هاتف'}</div>
        </div>
      </div>
      <div class="balance-hero">
        <div class="amount" style="${balance > 0 ? 'color:var(--danger);' : balance < 0 ? 'color:var(--success);' : 'color:var(--text-muted);'}">${formatMoney(Math.abs(balance))}</div>
        <div class="label">${balance > 0 ? 'الرصيد المستحق على الزبون' : balance < 0 ? 'له رصيد (دفع مسبقًا أكثر من المطلوب)' : 'لا يوجد رصيد مستحق'}</div>
        ${dueDate ? `<div class="label" style="${overdue ? 'color:var(--danger);font-weight:700;' : ''}margin-top:4px;">${overdue ? '⚠️ تجاوز موعد السداد المتوقع' : 'موعد السداد المتوقع'}: ${formatDate(dueDate)}</div>` : ''}
      </div>
      <button class="btn btn-primary btn-block" id="record-payment-btn">💵 تسجيل دفعة</button>
      <div class="icon-action-grid" style="margin-top:10px;">
        ${canManage ? `
        <button class="icon-action-btn" id="edit-customer-btn">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          تعديل بيانات الزبون
        </button>` : ''}
        <button class="icon-action-btn" id="add-charge-btn">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2h8l4 4v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M9 9h6M9 13h6M9 17h4"/></svg>
          إضافة دين
        </button>
        <button class="icon-action-btn" id="statement-btn">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2h9l3 3v17H6z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>
          كشف حساب
        </button>
      </div>
      ${canManage ? `<button class="btn btn-danger btn-block" style="margin-top:10px;" id="delete-customer-btn">🗑️ حذف الزبون</button>` : ''}
    </div>

    <div class="card" style="padding:10px;">
      <div class="seg-tabs">
        <button class="seg-tab active" data-tab="ledger">سجل الحركات</button>
        <button class="seg-tab" data-tab="sms">سجل الرسائل</button>
      </div>
      <div id="tab-content"></div>
    </div>
  `;

  const TAB_LIMIT = 4;

  function bindEntryClicks(root) {
    root.querySelectorAll('[data-ledger-open]').forEach(el => el.onclick = () => {
      const [type, id] = el.dataset.ledgerOpen.split(':');
      const entry = ledger.find(e => e.type === type && e.id === id);
      if (entry) openLedgerDetailSheet(entry);
    });
    root.querySelectorAll('[data-ledger-delete]').forEach(el => el.onclick = async (ev) => {
      ev.stopPropagation();
      const ok = await confirmDialog({ title: 'حذف الدفعة', message: 'سيتم حذف هذه الدفعة وستتأثر أرصدة الزبون والصندوق.' });
      if (!ok) return;
      try {
        await db.deletePayment(el.dataset.ledgerDelete);
        toastSuccess('تم حذف الدفعة');
        renderCustomerDetail(container, customerId);
      } catch (err) {
        toastError(err.message || 'حدث خطأ أثناء الحذف');
      }
    });
    root.querySelectorAll('[data-sms-open]').forEach(el => el.onclick = () => {
      const entry = smsLog.find(e => e.id === el.dataset.smsOpen);
      if (entry) openSmsDetailSheet(entry);
    });
  }

  function renderTabContent(tab) {
    if (tab === 'ledger') {
      const items = ledger.slice(0, TAB_LIMIT);
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="font-weight:800;font-size:14px;">آخر الحركات</div>
          ${ledger.length ? `<span class="badge" style="background:var(--bg);color:var(--text-muted);">آخر ${Math.min(TAB_LIMIT, ledger.length)}</span>` : ''}
        </div>
        ${ledger.length ? items.map(e => ledgerRow(e, canManage)).join('') : emptyState('📋', 'لا توجد حركات بعد')}
        ${ledger.length > TAB_LIMIT ? `<button class="btn btn-outline btn-block" style="margin-top:8px;" data-view-all="ledger">عرض جميع الحركات</button>` : ''}
      `;
    }
    const items = smsLog.slice(0, TAB_LIMIT);
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <div style="font-weight:800;font-size:14px;">آخر الرسائل</div>
        ${smsLog.length ? `<span class="badge" style="background:var(--bg);color:var(--text-muted);">آخر ${Math.min(TAB_LIMIT, smsLog.length)}</span>` : ''}
      </div>
      ${smsLog.length ? `<div class="meta" style="margin-bottom:6px;font-weight:700;">✅ ${smsSent}${smsFailed ? ` &nbsp;|&nbsp; ❌ ${smsFailed}` : ''}</div>` : ''}
      ${smsLog.length ? items.map(smsLogRow).join('') : emptyState('✉️', 'لا توجد رسائل مُرسلة لهذا الزبون بعد')}
      ${smsLog.length > TAB_LIMIT ? `<button class="btn btn-outline btn-block" style="margin-top:8px;" data-view-all="sms">عرض جميع الرسائل</button>` : ''}
    `;
  }

  function openFullListSheet(tab) {
    const isLedger = tab === 'ledger';
    const items = isLedger ? ledger : smsLog;
    const overlay = openSheet(`
      <div class="sheet-header"><h3>${isLedger ? 'كل الحركات' : 'كل الرسائل'}</h3>${closeBtnHtml()}</div>
      <div class="card" style="padding:6px 10px;max-height:65vh;overflow-y:auto;">
        ${items.length ? items.map(isLedger ? (e => ledgerRow(e, canManage)) : smsLogRow).join('') : emptyState(isLedger ? '📋' : '✉️', isLedger ? 'لا توجد حركات بعد' : 'لا توجد رسائل بعد')}
      </div>
    `);
    overlay.querySelector('[data-detail-close]').onclick = closeSheet;
    bindEntryClicks(overlay);
  }

  function renderActiveTab(tab) {
    const tabContentEl = container.querySelector('#tab-content');
    tabContentEl.innerHTML = renderTabContent(tab);
    bindEntryClicks(tabContentEl);
    const viewAllBtn = tabContentEl.querySelector('[data-view-all]');
    if (viewAllBtn) viewAllBtn.onclick = () => openFullListSheet(viewAllBtn.dataset.viewAll);
  }

  container.querySelectorAll('.seg-tab').forEach(btn => btn.onclick = () => {
    container.querySelectorAll('.seg-tab').forEach(b => b.classList.toggle('active', b === btn));
    renderActiveTab(btn.dataset.tab);
  });
  renderActiveTab('ledger');

  container.querySelector('#record-payment-btn').onclick = () => openRecordPaymentSheet(customer, balance, () => renderCustomerDetail(container, customerId));
  container.querySelector('#add-charge-btn').onclick = () => openAddChargeSheet(customer, () => renderCustomerDetail(container, customerId));
  container.querySelector('#statement-btn').onclick = () => window.location.hash = `#/customers/${customer.id}/statement`;

  if (canManage) {
    container.querySelector('#edit-customer-btn').onclick = () => openEditCustomerSheet(customer, () => renderCustomerDetail(container, customerId));
    container.querySelector('#delete-customer-btn').onclick = async () => {
      const ok = await confirmDialog({ title: 'حذف الزبون', message: `هل تريد حذف ${customer.name}؟` });
      if (!ok) return;
      try {
        await db.deleteCustomer(customerId);
        toastSuccess('تم حذف الزبون');
        window.location.hash = '#/customers';
      } catch (err) {
        toastError(err.message || 'حدث خطأ أثناء الحذف');
      }
    };
  }
}

// حذف الحركة متاح فقط لحركات الدفعات (نفس نمط suppliers.js) - حذف حركة دين (فاتورة بيع) يبقى فقط
// من شاشة الفاتورة نفسها لأنه عملية أعقد (تمسح بنود الفاتورة وتؤثر على المخزون المفاهيمي، لا مجرد صف واحد)
function ledgerRow(entry, canManage) {
  const isDebt = entry.direction === 'debt';
  const canDeletePayment = canManage && entry.type === 'payment';
  return `
    <div class="list-item" style="cursor:pointer;" data-ledger-open="${entry.type}:${entry.id}">
      <div class="avatar" style="background:${isDebt ? 'var(--danger-light)' : 'var(--success-light)'};color:${isDebt ? 'var(--danger)' : 'var(--success)'};">${isDebt ? '📝' : '💵'}</div>
      <div class="info">
        <div class="title">${escapeHtml(entry.label)}</div>
        <div class="subtitle">${formatDateTime(entry.date)}</div>
      </div>
      <div class="amount ${isDebt ? 'debt' : 'cash'}">${isDebt ? '+' : '-'}${formatMoney(entry.amount)}</div>
      ${canDeletePayment ? `<button class="remove-btn" data-ledger-delete="${entry.id}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
      </button>` : ''}
    </div>`;
}

const SMS_STATUS_LABELS = { sent: 'تم الإرسال', failed: 'فشلت', pending: 'قيد الإرسال' };

function smsLogRow(entry) {
  const color = { sent: 'var(--success)', failed: 'var(--danger)', pending: 'var(--warning)' }[entry.status] || 'var(--text-muted)';
  const bg = { sent: 'var(--success-light)', failed: 'var(--danger-light)' }[entry.status] || 'var(--border)';
  return `
    <div class="list-item" style="cursor:pointer;" data-sms-open="${entry.id}">
      <div class="avatar" style="background:${bg};color:${color};">📩</div>
      <div class="info">
        <div class="title">${escapeHtml((entry.message || '').slice(0, 45))}${(entry.message || '').length > 45 ? '...' : ''}</div>
        <div class="subtitle">${formatDateTime(entry.sent_at || entry.created_at)}</div>
        ${entry.error ? `<div class="meta" style="color:var(--danger);">${escapeHtml(entry.error)}</div>` : ''}
      </div>
      <div class="meta" style="color:${color};font-weight:700;">${SMS_STATUS_LABELS[entry.status] || entry.status}</div>
    </div>`;
}

function closeBtnHtml() {
  return `<button class="icon-btn" data-detail-close title="إغلاق"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`;
}

function todayInputValue(d = new Date()) { return d.toISOString().slice(0, 10); }
function firstOfMonthInputValue(d = new Date()) { return todayInputValue(new Date(d.getFullYear(), d.getMonth(), 1)); }

// كشف حساب قابل للطباعة/المشاركة: مرآة كاملة لكشف حساب المورد (suppliers.js) بنفس المنطق والتصميم،
// لكن بالاتجاه المعكوس: مدين = دين مسجَّل على الزبون، دائن = دفعة من الزبون
export async function renderCustomerStatement(container, customerId, range) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const [customer, settings, ledgerDesc] = await Promise.all([
    db.getCustomer(customerId), db.getSettings(), db.getCustomerLedger(customerId)
  ]);
  if (!customer) { container.innerHTML = `<div class="card">الزبون غير موجود</div>`; return; }

  const fromInput = range?.from || firstOfMonthInputValue();
  const toInput = range?.to || todayInputValue();
  const rangeStart = startOfDay(new Date(fromInput));
  const rangeEnd = endOfDay(new Date(toInput));

  const ledgerAsc = [...ledgerDesc].sort((a, b) => a.date.localeCompare(b.date));
  const before = ledgerAsc.filter(e => new Date(e.date) < rangeStart);
  const inRange = ledgerAsc.filter(e => { const d = new Date(e.date); return d >= rangeStart && d <= rangeEnd; });

  const openingBalance = before.reduce((s, e) => s + (e.direction === 'debt' ? e.amount : -e.amount), 0);
  let running = openingBalance;
  const rows = inRange.map(entry => {
    running += entry.direction === 'debt' ? entry.amount : -entry.amount;
    return { ...entry, runningBalance: running };
  });
  const closingBalance = running;
  const periodDebt = inRange.filter(e => e.direction === 'debt').reduce((s, e) => s + e.amount, 0);
  const periodPaid = inRange.filter(e => e.direction === 'payment').reduce((s, e) => s + e.amount, 0);

  const balanceState = closingBalance > 0
    ? { text: 'الرصيد المستحق على الزبون', color: 'var(--danger)', bg: 'var(--danger-light)', amount: closingBalance }
    : closingBalance < 0
      ? { text: 'له رصيد (دفع مسبقًا أكثر من المطلوب)', color: 'var(--success)', bg: 'var(--success-light)', amount: -closingBalance }
      : { text: 'الحساب مسدد بالكامل', color: 'var(--text-muted)', bg: 'var(--bg)', amount: 0 };

  const issuedAt = formatDate(new Date().toISOString(), { year: true });
  const formatInputDate = (isoDateOnly) => { const [y, m, d] = isoDateOnly.split('-'); return `${d}/${m}/${y}`; };
  const periodLabel = `${formatInputDate(fromInput)} - ${formatInputDate(toInput)}`;

  function headerRowsHtml() {
    return `
      <tr class="stmt-head-row"><th colspan="6" style="text-align:center;font-size:18px;font-weight:800;border:none;padding-bottom:2px;">${escapeHtml(settings.shopName)}</th></tr>
      ${settings.phone || settings.address ? `<tr class="stmt-head-row"><th colspan="6" style="text-align:center;font-weight:400;font-size:12px;color:var(--text-muted);border:none;padding-top:0;padding-bottom:10px;">${escapeHtml(settings.phone || '')}${settings.address ? ' - ' + escapeHtml(settings.address) : ''}</th></tr>` : ''}
      <tr class="stmt-head-row"><th colspan="6" style="text-align:center;font-weight:800;font-size:15px;border:none;padding-bottom:10px;">كشف حساب زبون</th></tr>
      <tr class="stmt-head-row">
        <th colspan="3" style="text-align:right;font-weight:700;border:none;">الزبون: ${escapeHtml(customer.name)}${customer.phone ? ' - ' + escapeHtml(customer.phone) : ''}</th>
        <th colspan="3" style="text-align:left;font-weight:400;color:var(--text-muted);border:none;">تاريخ الإصدار: ${issuedAt}</th>
      </tr>
      <tr class="stmt-head-row">
        <th colspan="6" style="text-align:right;font-weight:700;border-bottom:1.5px solid var(--border);padding-bottom:10px;">الفترة: ${periodLabel}</th>
      </tr>
      <tr class="stmt-col-head">
        <th>التاريخ</th><th>البيان</th><th>رقم المرجع</th><th>مدين</th><th>دائن</th><th>الرصيد</th>
      </tr>`;
  }

  container.innerHTML = `
    <div class="no-print card" id="stmt-range-form">
      <div class="section-title" style="margin-top:0;">فترة الكشف</div>
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">
        <div class="form-group" style="flex:1;min-width:130px;margin-bottom:0;"><label>من تاريخ</label><input type="date" id="stmt-from" value="${fromInput}"></div>
        <div class="form-group" style="flex:1;min-width:130px;margin-bottom:0;"><label>إلى تاريخ</label><input type="date" id="stmt-to" value="${toInput}"></div>
        <button class="btn btn-primary" id="stmt-apply" style="height:44px;">تطبيق</button>
      </div>
    </div>

    <div class="card" id="statement-card">
      <table class="simple-table stmt-table">
        <thead>${headerRowsHtml()}</thead>
        <tbody>
          ${rows.length ? rows.map(r => `
            <tr>
              <td>${formatDate(r.date, { year: true })}</td>
              <td>${escapeHtml(r.description || r.label)}</td>
              <td>${r.reference ? escapeHtml(r.reference) : '—'}</td>
              <td style="color:var(--danger);font-weight:700;">${r.direction === 'debt' ? formatMoney(r.amount) : '—'}</td>
              <td style="color:var(--success);font-weight:700;">${r.direction === 'payment' ? formatMoney(r.amount) : '—'}</td>
              <td style="font-weight:800;">${formatMoney(r.runningBalance)}</td>
            </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;padding:24px 8px;color:var(--text-muted);">لا توجد حركات خلال هذه الفترة</td></tr>`}
        </tbody>
      </table>

      <div class="totals-box" style="margin-top:16px;">
        <div class="row"><span>الرصيد السابق</span><span>${formatMoney(Math.abs(openingBalance))} ${openingBalance < 0 ? '(له رصيد)' : ''}</span></div>
        <div class="row"><span>إجمالي الديون المسجّلة (مدين)</span><span>${formatMoney(periodDebt)}</span></div>
        <div class="row"><span>إجمالي الدفعات (دائن)</span><span>${formatMoney(periodPaid)}</span></div>
      </div>

      <div style="background:${balanceState.bg};border-radius:var(--radius-sm);padding:16px;margin-top:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
        <span style="font-weight:800;font-size:15px;color:${balanceState.color};">${balanceState.text}</span>
        <span style="font-weight:800;font-size:22px;color:${balanceState.color};">${formatMoney(balanceState.amount)}</span>
      </div>

      <div class="print-only" style="text-align:center;margin-top:18px;font-size:12px;color:#888;">كشف حساب للمراجعة - ليس فاتورة</div>
    </div>

    <div class="no-print" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;">
      <button class="btn btn-secondary" id="stmt-print">🖨️ طباعة / حفظ PDF</button>
      <button class="btn btn-secondary" id="stmt-share">📤 مشاركة</button>
    </div>
  `;

  container.querySelector('#stmt-apply').onclick = () => {
    const from = container.querySelector('#stmt-from').value;
    const to = container.querySelector('#stmt-to').value;
    if (!from || !to) return toastError('اختر تاريخ البداية والنهاية');
    if (from > to) return toastError('تاريخ البداية يجب أن يسبق تاريخ النهاية');
    renderCustomerStatement(container, customerId, { from, to });
  };

  container.querySelector('#stmt-print').onclick = () => {
    const originalTitle = document.title;
    document.title = `كشف حساب (${customer.name}) (${todayInputValue()})`;
    const restoreTitle = () => { document.title = originalTitle; window.removeEventListener('afterprint', restoreTitle); };
    window.addEventListener('afterprint', restoreTitle);
    window.print();
  };
  container.querySelector('#stmt-share').onclick = async () => {
    const text = `كشف حساب زبون - ${settings.shopName}\nالزبون: ${customer.name}\nالفترة: ${periodLabel}\n${balanceState.text}: ${formatMoney(balanceState.amount)}\nتاريخ الإصدار: ${issuedAt}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'كشف حساب زبون', text }); }
      catch (e) { /* المستخدم أغلق نافذة المشاركة */ }
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      toastSuccess('تم نسخ ملخص كشف الحساب');
    }
  };
}

function openLedgerDetailSheet(entry) {
  const isDebt = entry.direction === 'debt';
  const overlay = openSheet(`
    <div class="sheet-header"><h3>تفاصيل الحركة</h3>${closeBtnHtml()}</div>
    <div style="text-align:center;margin-bottom:14px;">
      <div class="amount ${isDebt ? 'debt' : 'cash'}" style="font-size:24px;">${isDebt ? '+' : '-'}${formatMoney(entry.amount)}</div>
      <div class="meta">${isDebt ? 'دين مسجّل على الزبون' : 'دفعة من الزبون'}</div>
    </div>
    <div class="form-group"><label>الوصف</label><p style="margin:4px 0;">${escapeHtml(entry.label)}</p></div>
    <div class="form-group"><label>التاريخ والوقت</label><p style="margin:4px 0;">${formatDateTime(entry.date)}</p></div>
    ${entry.notes ? `<div class="form-group"><label>ملاحظات</label><p style="margin:4px 0;">${escapeHtml(entry.notes)}</p></div>` : ''}
  `);
  overlay.querySelector('[data-detail-close]').onclick = closeSheet;
}

function openSmsDetailSheet(entry) {
  const color = { sent: 'var(--success)', failed: 'var(--danger)', pending: 'var(--warning)' }[entry.status] || 'var(--text-muted)';
  const overlay = openSheet(`
    <div class="sheet-header"><h3>تفاصيل الرسالة</h3>${closeBtnHtml()}</div>
    <div class="form-group"><label>نص الرسالة</label><p style="margin:4px 0;white-space:pre-wrap;">${escapeHtml(entry.message || '')}</p></div>
    <div class="form-group"><label>الحالة</label><p style="margin:4px 0;color:${color};font-weight:700;">${SMS_STATUS_LABELS[entry.status] || entry.status}</p></div>
    ${entry.error ? `<div class="form-group"><label>سبب الفشل</label><p style="margin:4px 0;color:var(--danger);">${escapeHtml(entry.error)}</p></div>` : ''}
    ${entry.phone ? `<div class="form-group"><label>رقم الهاتف</label><p style="margin:4px 0;">${escapeHtml(entry.phone)}</p></div>` : ''}
    <div class="form-group"><label>وقت الإرسال</label><p style="margin:4px 0;">${formatDateTime(entry.sent_at || entry.created_at)}</p></div>
  `);
  overlay.querySelector('[data-detail-close]').onclick = closeSheet;
}

export function openRecordPaymentSheet(customer, currentBalance, onDone) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>تسجيل دفعة - ${escapeHtml(customer.name)}</h3></div>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">الرصيد الحالي: <b style="color:var(--danger);">${formatMoney(Math.max(0, currentBalance))}</b></div>
    <div class="form-group"><label>المبلغ</label><input type="number" id="pay-amount" step="0.5" min="0" placeholder="0"></div>
    <div class="form-group">
      <label>طريقة الدفع</label>
      <div class="pay-methods" style="grid-template-columns:1fr 1fr;">
        <div class="pay-method-btn active" data-method="cash"><span class="emoji">💵</span>نقدي</div>
        <div class="pay-method-btn" data-method="transfer"><span class="emoji">📱</span>تحويل</div>
      </div>
    </div>
    <div class="form-group"><label>ملاحظات (اختياري)</label><textarea id="pay-notes"></textarea></div>
    <div id="pay-preview" style="font-size:13px;font-weight:700;margin-bottom:12px;color:var(--text-muted);"></div>
    <button class="btn btn-primary btn-block" id="pay-save">حفظ الدفعة</button>
  `, { onOpen: (el) => el.querySelector('#pay-amount').focus() });

  let method = 'cash';
  overlay.querySelectorAll('.pay-method-btn').forEach(btn => btn.onclick = () => {
    method = btn.dataset.method;
    overlay.querySelectorAll('.pay-method-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  const updatePreview = () => {
    const amount = toCents(overlay.querySelector('#pay-amount').value || 0);
    const newBalance = currentBalance - amount;
    overlay.querySelector('#pay-preview').innerHTML = amount > 0
      ? `الرصيد الجديد بعد الدفعة: <span style="color:${newBalance > 0 ? 'var(--danger)' : 'var(--success)'};">${formatMoney(Math.abs(newBalance))}</span>`
      : '';
  };
  overlay.querySelector('#pay-amount').oninput = updatePreview;

  overlay.querySelector('#pay-save').onclick = async () => {
    const btn = overlay.querySelector('#pay-save');
    const amount = parseFloat(overlay.querySelector('#pay-amount').value);
    if (!amount || amount <= 0) return toastError('أدخل مبلغًا صحيحًا');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      await db.addPayment({ customerId: customer.id, amount, method, notes: overlay.querySelector('#pay-notes').value.trim() });
      closeSheet();
      toastSuccess('تم تسجيل الدفعة وتحديث رصيد الزبون');
      if (onDone) onDone();
    } catch (err) {
      toastError(err.message || 'حدث خطأ أثناء حفظ الدفعة. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };
}

function openAddChargeSheet(customer, onDone) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>إضافة دين - ${escapeHtml(customer.name)}</h3></div>
    <p style="font-size:12.5px;color:var(--text-muted);margin-top:-6px;">لتسجيل دين بمبلغ مباشر بدون اختيار منتجات (مثلاً رسوم أو تسوية دين).</p>
    <div class="form-group"><label>المبلغ</label><input type="number" id="charge-amount" step="0.5" min="0" placeholder="0"></div>
    <div class="form-group"><label>ملاحظات (اختياري)</label><textarea id="charge-notes" placeholder="سبب الدين"></textarea></div>
    <button class="btn btn-primary btn-block" id="charge-save">حفظ</button>
  `, { onOpen: (el) => el.querySelector('#charge-amount').focus() });

  overlay.querySelector('#charge-save').onclick = async () => {
    const btn = overlay.querySelector('#charge-save');
    const amount = parseFloat(overlay.querySelector('#charge-amount').value);
    if (!amount || amount <= 0) return toastError('أدخل مبلغًا صحيحًا');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      await db.addManualDebtCharge({
        customerId: customer.id, customerName: customer.name, amount,
        notes: overlay.querySelector('#charge-notes').value.trim()
      });
      closeSheet();
      toastSuccess('تم تسجيل الدين على الزبون');
      if (onDone) onDone();
    } catch (err) {
      toastError(err.message || 'حدث خطأ أثناء الحفظ. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };
}

function openEditCustomerSheet(customer, onSaved) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>تعديل بيانات الزبون</h3></div>
    <div class="form-group"><label>الاسم</label><input type="text" id="ec-name" value="${escapeHtml(customer.name)}"></div>
    <div class="form-group"><label>رقم الهاتف</label><input type="tel" id="ec-phone" value="${escapeHtml(customer.phone || '')}"></div>
    <div class="form-group">
      <label>نظام السداد (اختياري)</label>
      <select id="ec-cycle">
        <option value="" ${!customer.payment_cycle ? 'selected' : ''}>بدون تحديد</option>
        <option value="weekly" ${customer.payment_cycle === 'weekly' ? 'selected' : ''}>أسبوعي</option>
        <option value="monthly" ${customer.payment_cycle === 'monthly' ? 'selected' : ''}>شهري</option>
      </select>
    </div>
    <div class="form-group"><label>ملاحظات</label><textarea id="ec-notes">${escapeHtml(customer.notes || '')}</textarea></div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;margin-bottom:16px;">
      <input type="checkbox" id="ec-sms-excluded" ${customer.sms_excluded ? 'checked' : ''}> استثناء هذا الزبون من رسائل SMS التذكيرية
    </label>
    <button class="btn btn-primary btn-block" id="ec-save">حفظ التعديلات</button>
  `);
  overlay.querySelector('#ec-save').onclick = async () => {
    const name = overlay.querySelector('#ec-name').value.trim();
    if (!name) return toastError('أدخل اسم الزبون');
    const phone = overlay.querySelector('#ec-phone').value.trim();
    if (!isValidPhone(phone)) return toastError('رقم الجوال يجب أن يكون 10 أرقام فقط');
    const btn = overlay.querySelector('#ec-save');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      await db.updateCustomer(customer.id, {
        name, phone, notes: overlay.querySelector('#ec-notes').value.trim(),
        payment_cycle: overlay.querySelector('#ec-cycle').value || null,
        sms_excluded: overlay.querySelector('#ec-sms-excluded').checked
      });
      closeSheet();
      toastSuccess('تم تحديث بيانات الزبون');
      onSaved();
    } catch (err) {
      toastError('حدث خطأ أثناء الحفظ. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };
}

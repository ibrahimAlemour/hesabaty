// شاشات الموردين: القائمة، إضافة، تفاصيل الحساب، تسجيل دفعة
// نظام مستقل تمامًا عن شاشات الزبائن (customers.js): حساب ورصيد وسجل حركات وفواتير خاصة بكل مورد، بدون أي تشارك بينهما
import * as db from './database.js';
import { canDelete, getCurrentUser } from './auth.js';
import { formatMoney, formatDateTime, formatDate, escapeHtml, fuzzyMatch, debounce, startOfDay, endOfDay } from './utils.js';
import { toastError, toastSuccess, setLoading, openSheet, closeSheet, confirmDialog, emptyState } from './ui.js';

export async function renderSupplierList(container) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const suppliers = await db.getSuppliersWithBalance();
  renderList(container, suppliers, '');
}

function renderList(container, suppliers, query) {
  const filtered = query ? suppliers.filter(s => fuzzyMatch(s.name, query) || (s.phone && s.phone.includes(query))) : suppliers;
  container.innerHTML = `
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input type="text" id="supplier-search" placeholder="ابحث بالاسم أو الهاتف..." value="${escapeHtml(query)}">
    </div>
    <button class="btn btn-primary btn-block" id="add-supplier-btn" style="margin-bottom:14px;">+ إضافة مورد</button>
    <div class="card" style="padding:6px 10px;">
      ${filtered.length ? filtered.map(supplierRow).join('') : emptyState('🚚', 'لا يوجد موردون', 'أضف أول مورد للبدء')}
    </div>
  `;
  container.querySelector('#supplier-search').oninput = debounce((e) => renderList(container, suppliers, e.target.value), 150);
  container.querySelector('#supplier-search').focus();
  container.querySelector('#supplier-search').setSelectionRange(query.length, query.length);
  container.querySelector('#add-supplier-btn').onclick = () => openAddSupplierSheet(container);
  container.querySelectorAll('[data-open]').forEach(el => el.onclick = () => window.location.hash = `#/suppliers/${el.dataset.open}`);
}

function supplierRow(s) {
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

function openAddSupplierSheet(container, onSaved) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>+ إضافة مورد</h3></div>
    <div class="form-group"><label>الاسم</label><input type="text" id="ns-name" placeholder="اسم المورد أو التاجر"></div>
    <div class="form-group"><label>رقم الهاتف (اختياري)</label><input type="tel" id="ns-phone" placeholder="05xxxxxxxx"></div>
    <div class="form-group"><label>العنوان (اختياري)</label><input type="text" id="ns-address" placeholder="العنوان"></div>
    <div class="form-group"><label>ملاحظات (اختياري)</label><textarea id="ns-notes"></textarea></div>
    <button class="btn btn-primary btn-block" id="ns-save">حفظ</button>
  `, { onOpen: (el) => el.querySelector('#ns-name').focus() });

  overlay.querySelector('#ns-save').onclick = async () => {
    const name = overlay.querySelector('#ns-name').value.trim();
    if (!name) return toastError('أدخل اسم المورد');
    const btn = overlay.querySelector('#ns-save');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      const supplier = await db.addSupplier({
        name, phone: overlay.querySelector('#ns-phone').value.trim(),
        address: overlay.querySelector('#ns-address').value.trim(),
        notes: overlay.querySelector('#ns-notes').value.trim()
      });
      closeSheet();
      toastSuccess('تم إضافة المورد');
      if (onSaved) onSaved(supplier); else renderSupplierList(container);
    } catch (err) {
      toastError('حدث خطأ أثناء حفظ المورد. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };
}

export async function renderSupplierDetail(container, supplierId) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const [supplier, balance, purchases, ledger, user] = await Promise.all([
    db.getSupplier(supplierId), db.getSupplierBalance(supplierId), db.getPurchases({ supplierId }), db.getSupplierLedger(supplierId), getCurrentUser()
  ]);
  if (!supplier) { container.innerHTML = `<div class="card">المورد غير موجود</div>`; return; }
  const canManage = canDelete(user);
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
        <div class="label">${balance > 0 ? 'المستحق لهذا المورد' : 'لا يوجد رصيد مستحق'}</div>
      </div>
      <div style="display:flex;gap:10px;justify-content:center;font-size:12.5px;color:var(--text-muted);margin-bottom:14px;">
        <span>إجمالي المشتريات: <b style="color:var(--text);">${formatMoney(totalPurchases)}</b></span>
      </div>
      <button class="btn btn-primary btn-block" id="record-payment-btn">💵 تسجيل دفعة</button>
      <div class="icon-action-grid" style="margin-top:10px;">
        <button class="icon-action-btn" id="add-purchase-btn">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2h8l4 4v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M9 9h6M9 13h6M9 17h4"/></svg>
          إضافة فاتورة شراء
        </button>
        <button class="icon-action-btn" id="statement-btn">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2h9l3 3v17H6z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>
          كشف حساب
        </button>
        ${canManage ? `
        <button class="icon-action-btn" id="edit-supplier-btn">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          تعديل بيانات المورد
        </button>` : ''}
      </div>
      ${canManage ? `<button class="btn btn-danger btn-block" style="margin-top:10px;" id="delete-supplier-btn">🗑️ حذف المورد</button>` : ''}
    </div>

    <div class="card" style="padding:10px;">
      <div class="seg-tabs">
        <button class="seg-tab active" data-tab="invoices">فواتير الشراء</button>
        <button class="seg-tab" data-tab="ledger">سجل الحركات</button>
      </div>
      <div id="tab-content"></div>
    </div>
  `;

  const TAB_LIMIT = 6;

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

  function renderTabContent(tab) {
    if (tab === 'invoices') {
      const items = purchases.slice(0, TAB_LIMIT);
      return `
        ${purchases.length ? items.map(invoiceRow).join('') : emptyState('🧾', 'لا توجد فواتير شراء بعد')}
        ${purchases.length > TAB_LIMIT ? `<button class="btn btn-outline btn-block" style="margin-top:8px;" data-view-all="invoices">عرض جميع الفواتير</button>` : ''}
      `;
    }
    const items = ledger.slice(0, TAB_LIMIT);
    return `
      ${ledger.length ? items.map(ledgerRow).join('') : emptyState('📋', 'لا توجد حركات بعد')}
      ${ledger.length > TAB_LIMIT ? `<button class="btn btn-outline btn-block" style="margin-top:8px;" data-view-all="ledger">عرض جميع الحركات</button>` : ''}
    `;
  }

  function bindInvoiceClicks(root) {
    root.querySelectorAll('[data-invoice-open]').forEach(el => el.onclick = () => window.location.hash = `#/purchase/${el.dataset.invoiceOpen}`);
  }

  function openFullListSheet(tab) {
    const isInvoices = tab === 'invoices';
    const overlay = openSheet(`
      <div class="sheet-header"><h3>${isInvoices ? 'كل فواتير الشراء' : 'كل الحركات'}</h3>${closeBtnHtml()}</div>
      <div class="card" style="padding:6px 10px;max-height:65vh;overflow-y:auto;">
        ${isInvoices
          ? (purchases.length ? purchases.map(invoiceRow).join('') : emptyState('🧾', 'لا توجد فواتير بعد'))
          : (ledger.length ? ledger.map(ledgerRow).join('') : emptyState('📋', 'لا توجد حركات بعد'))}
      </div>
    `);
    overlay.querySelector('[data-detail-close]').onclick = closeSheet;
    if (isInvoices) bindInvoiceClicks(overlay);
  }

  function renderActiveTab(tab) {
    const tabContentEl = container.querySelector('#tab-content');
    tabContentEl.innerHTML = renderTabContent(tab);
    if (tab === 'invoices') bindInvoiceClicks(tabContentEl);
    const viewAllBtn = tabContentEl.querySelector('[data-view-all]');
    if (viewAllBtn) viewAllBtn.onclick = () => openFullListSheet(viewAllBtn.dataset.viewAll);
  }

  container.querySelectorAll('.seg-tab').forEach(btn => btn.onclick = () => {
    container.querySelectorAll('.seg-tab').forEach(b => b.classList.toggle('active', b === btn));
    renderActiveTab(btn.dataset.tab);
  });
  renderActiveTab('invoices');

  container.querySelector('#record-payment-btn').onclick = () => openRecordSupplierPaymentSheet(supplier, balance, () => renderSupplierDetail(container, supplierId));
  container.querySelector('#add-purchase-btn').onclick = () => window.location.hash = `#/purchase/new/${supplier.id}`;
  container.querySelector('#statement-btn').onclick = () => window.location.hash = `#/suppliers/${supplier.id}/statement`;

  if (canManage) {
    container.querySelector('#edit-supplier-btn').onclick = () => openEditSupplierSheet(supplier, () => renderSupplierDetail(container, supplierId));
    container.querySelector('#delete-supplier-btn').onclick = async () => {
      const ok = await confirmDialog({ title: 'حذف المورد', message: `هل تريد حذف ${supplier.name}؟` });
      if (!ok) return;
      try {
        await db.deleteSupplier(supplierId);
        toastSuccess('تم حذف المورد');
        window.location.hash = '#/suppliers';
      } catch (err) {
        toastError(err.message || 'حدث خطأ أثناء الحذف');
      }
    };
  }
}

// كشف حساب قابل للطباعة/المشاركة: كل حركات المورد بترتيب تاريخي (الأقدم أولًا) مع رصيد تراكمي بعد كل حركة،
// بنفس نمط طباعة الفاتورة الموجود بـinvoice.js/purchases.js (window.print فقط - بدون مكتبة PDF جديدة)
function todayInputValue(d = new Date()) { return d.toISOString().slice(0, 10); }
function firstOfMonthInputValue(d = new Date()) { return todayInputValue(new Date(d.getFullYear(), d.getMonth(), 1)); }

export async function renderSupplierStatement(container, supplierId, range) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const [supplier, settings, ledgerDesc] = await Promise.all([
    db.getSupplier(supplierId), db.getSettings(), db.getSupplierLedger(supplierId)
  ]);
  if (!supplier) { container.innerHTML = `<div class="card">المورد غير موجود</div>`; return; }

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
    ? { text: 'الرصيد المستحق للمورد', color: 'var(--danger)', bg: 'var(--danger-light)', amount: closingBalance }
    : closingBalance < 0
      ? { text: 'رصيد لصالح المحل', color: 'var(--success)', bg: 'var(--success-light)', amount: -closingBalance }
      : { text: 'الحساب مسدد بالكامل', color: 'var(--text-muted)', bg: 'var(--bg)', amount: 0 };

  const issuedAt = formatDate(new Date().toISOString(), { year: true });
  // نبني نص الفترة من نص التاريخ المُدخَل مباشرة (YYYY-MM-DD) بدون أي تحويل Date/منطقة زمنية، حتى لا يظهر
  // تاريخ مختلف بيوم واحد بسبب فرق التوقيت بين حدود اليوم المحسوبة بالتوقيت المحلي للجهاز وعرضها بتوقيت غزة
  const formatInputDate = (isoDateOnly) => { const [y, m, d] = isoDateOnly.split('-'); return `${d}/${m}/${y}`; };
  const periodLabel = `${formatInputDate(fromInput)} - ${formatInputDate(toInput)}`;

  function headerRowsHtml() {
    // هذه الصفوف داخل <thead> عمدًا (لا كعنصر منفصل خارج الجدول): متصفحات الطباعة تكرّر <thead> تلقائيًا
    // بأعلى كل صفحة عند تعدد الصفحات، وهذه هي الطريقة الموثوقة الوحيدة لضمان ظهور بيانات الكشف الأساسية
    // بكل صفحة (لا يوجد ضمان مماثل لعنصر HTML عادي خارج الجدول عبر جميع المتصفحات)
    return `
      <tr class="stmt-head-row"><th colspan="6" style="text-align:center;font-size:18px;font-weight:800;border:none;padding-bottom:2px;">${escapeHtml(settings.shopName)}</th></tr>
      ${settings.phone || settings.address ? `<tr class="stmt-head-row"><th colspan="6" style="text-align:center;font-weight:400;font-size:12px;color:var(--text-muted);border:none;padding-top:0;padding-bottom:10px;">${escapeHtml(settings.phone || '')}${settings.address ? ' - ' + escapeHtml(settings.address) : ''}</th></tr>` : ''}
      <tr class="stmt-head-row"><th colspan="6" style="text-align:center;font-weight:800;font-size:15px;border:none;padding-bottom:10px;">كشف حساب مورد</th></tr>
      <tr class="stmt-head-row">
        <th colspan="3" style="text-align:right;font-weight:700;border:none;">المورد: ${escapeHtml(supplier.name)}${supplier.phone ? ' - ' + escapeHtml(supplier.phone) : ''}</th>
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
        <div class="row"><span>الرصيد السابق</span><span>${formatMoney(Math.abs(openingBalance))} ${openingBalance < 0 ? '(لصالح المحل)' : ''}</span></div>
        <div class="row"><span>إجمالي المشتريات الآجلة (مدين)</span><span>${formatMoney(periodDebt)}</span></div>
        <div class="row"><span>إجمالي المدفوعات (دائن)</span><span>${formatMoney(periodPaid)}</span></div>
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
    renderSupplierStatement(container, supplierId, { from, to });
  };

  container.querySelector('#stmt-print').onclick = () => {
    // متصفحات كروم تقترح document.title كاسم افتراضي عند "حفظ كـ PDF" من نافذة الطباعة، فنغيّره مؤقتًا
    // إلى اسم واضح (كشف حساب + اسم المورد + تاريخ اليوم) بدل عنوان الصفحة العام، ثم نعيده بعد إغلاق نافذة الطباعة
    const originalTitle = document.title;
    document.title = `كشف حساب (${supplier.name}) (${todayInputValue()})`;
    const restoreTitle = () => { document.title = originalTitle; window.removeEventListener('afterprint', restoreTitle); };
    window.addEventListener('afterprint', restoreTitle);
    window.print();
  };
  container.querySelector('#stmt-share').onclick = async () => {
    const text = `كشف حساب مورد - ${settings.shopName}\nالمورد: ${supplier.name}\nالفترة: ${periodLabel}\n${balanceState.text}: ${formatMoney(balanceState.amount)}\nتاريخ الإصدار: ${issuedAt}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'كشف حساب مورد', text }); }
      catch (e) { /* المستخدم أغلق نافذة المشاركة */ }
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      toastSuccess('تم نسخ ملخص كشف الحساب');
    }
  };
}

function closeBtnHtml() {
  return `<button class="icon-btn" data-detail-close title="إغلاق"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`;
}

export function openRecordSupplierPaymentSheet(supplier, currentBalance, onDone) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>تسجيل دفعة - ${escapeHtml(supplier.name)}</h3></div>
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">المستحق حاليًا: <b style="color:var(--danger);">${formatMoney(Math.max(0, currentBalance))}</b></div>
    <div class="form-group"><label>المبلغ</label><input type="number" id="sp-amount" step="0.5" min="0" placeholder="0"></div>
    <div class="form-group">
      <label>طريقة الدفع</label>
      <div class="pay-methods" style="grid-template-columns:1fr 1fr 1fr;">
        <div class="pay-method-btn active" data-method="cash"><span class="emoji">💵</span>نقدي</div>
        <div class="pay-method-btn" data-method="transfer"><span class="emoji">📱</span>تحويل</div>
        <div class="pay-method-btn" data-method="card"><span class="emoji">💳</span>بطاقة</div>
      </div>
    </div>
    <div class="form-group"><label>ملاحظات (اختياري)</label><textarea id="sp-notes"></textarea></div>
    <div id="sp-preview" style="font-size:13px;font-weight:700;margin-bottom:12px;color:var(--text-muted);"></div>
    <button class="btn btn-primary btn-block" id="sp-save">حفظ الدفعة</button>
  `, { onOpen: (el) => el.querySelector('#sp-amount').focus() });

  let method = 'cash';
  overlay.querySelectorAll('.pay-method-btn').forEach(btn => btn.onclick = () => {
    method = btn.dataset.method;
    overlay.querySelectorAll('.pay-method-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  const updatePreview = () => {
    const amount = Math.round((parseFloat(overlay.querySelector('#sp-amount').value) || 0) * 100);
    const newBalance = currentBalance - amount;
    overlay.querySelector('#sp-preview').innerHTML = amount > 0
      ? `الرصيد الجديد بعد الدفعة: <span style="color:${newBalance > 0 ? 'var(--danger)' : 'var(--success)'};">${formatMoney(Math.abs(newBalance))}</span>`
      : '';
  };
  overlay.querySelector('#sp-amount').oninput = updatePreview;

  overlay.querySelector('#sp-save').onclick = async () => {
    const btn = overlay.querySelector('#sp-save');
    const amount = parseFloat(overlay.querySelector('#sp-amount').value);
    if (!amount || amount <= 0) return toastError('أدخل مبلغًا صحيحًا');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      await db.addSupplierPayment({ supplierId: supplier.id, amount, method, notes: overlay.querySelector('#sp-notes').value.trim() });
      closeSheet();
      toastSuccess('تم تسجيل الدفعة وتحديث رصيد المورد');
      if (onDone) onDone();
    } catch (err) {
      toastError(err.message || 'حدث خطأ أثناء حفظ الدفعة. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };
}

function openEditSupplierSheet(supplier, onSaved) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>تعديل بيانات المورد</h3></div>
    <div class="form-group"><label>الاسم</label><input type="text" id="es-name" value="${escapeHtml(supplier.name)}"></div>
    <div class="form-group"><label>رقم الهاتف</label><input type="tel" id="es-phone" value="${escapeHtml(supplier.phone || '')}"></div>
    <div class="form-group"><label>العنوان</label><input type="text" id="es-address" value="${escapeHtml(supplier.address || '')}"></div>
    <div class="form-group"><label>ملاحظات</label><textarea id="es-notes">${escapeHtml(supplier.notes || '')}</textarea></div>
    <button class="btn btn-primary btn-block" id="es-save">حفظ التعديلات</button>
  `);
  overlay.querySelector('#es-save').onclick = async () => {
    const name = overlay.querySelector('#es-name').value.trim();
    if (!name) return toastError('أدخل اسم المورد');
    const btn = overlay.querySelector('#es-save');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      await db.updateSupplier(supplier.id, {
        name, phone: overlay.querySelector('#es-phone').value.trim(),
        address: overlay.querySelector('#es-address').value.trim(),
        notes: overlay.querySelector('#es-notes').value.trim()
      });
      closeSheet();
      toastSuccess('تم تحديث بيانات المورد');
      onSaved();
    } catch (err) {
      toastError('حدث خطأ أثناء الحفظ. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };
}

// شاشات الزبائن: القائمة، إضافة، تفاصيل الحساب، تسجيل دفعة
import * as db from './database.js';
import { canDelete, getCurrentUser } from './auth.js';
import { formatMoney, formatDateTime, formatDate, escapeHtml, fuzzyMatch, debounce, toCents } from './utils.js';
import { toastError, toastSuccess, setLoading, openSheet, closeSheet, confirmDialog, emptyState } from './ui.js';

export async function renderCustomerList(container) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const customers = await db.getCustomersWithBalance();
  renderList(container, customers, '');
}

function renderList(container, customers, query) {
  const filtered = query ? customers.filter(c => fuzzyMatch(c.name, query) || (c.phone && c.phone.includes(query))) : customers;
  container.innerHTML = `
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input type="text" id="customer-search" placeholder="ابحث بالاسم أو الهاتف..." value="${escapeHtml(query)}">
    </div>
    <button class="btn btn-primary btn-block" id="add-customer-btn" style="margin-bottom:14px;">+ إضافة زبون</button>
    <div class="card" style="padding:6px 10px;">
      ${filtered.length ? filtered.map(customerRow).join('') : emptyState('👥', 'لا يوجد زبائن', 'أضف أول زبون للبدء')}
    </div>
  `;
  container.querySelector('#customer-search').oninput = debounce((e) => renderList(container, customers, e.target.value), 150);
  container.querySelector('#customer-search').focus();
  container.querySelector('#customer-search').setSelectionRange(query.length, query.length);
  container.querySelector('#add-customer-btn').onclick = () => openAddCustomerSheet(container);
  container.querySelectorAll('[data-open]').forEach(el => el.onclick = () => window.location.hash = `#/customers/${el.dataset.open}`);
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
    const btn = overlay.querySelector('#nc-save');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      const customer = await db.addCustomer({
        name, phone: overlay.querySelector('#nc-phone').value.trim(), notes: overlay.querySelector('#nc-notes').value.trim(),
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
      <button class="btn btn-outline btn-block" style="margin-top:8px;" id="add-charge-btn">📝 إضافة دين (بدون منتجات)</button>
      ${canManage ? `<button class="btn btn-outline btn-block" style="margin-top:8px;" id="edit-customer-btn">تعديل بيانات الزبون</button>
      <button class="btn btn-danger btn-block" style="margin-top:8px;" id="delete-customer-btn">حذف الزبون</button>` : ''}
    </div>

    <div class="section-title">سجل الحركات</div>
    <div class="card" style="padding:6px 10px;">
      ${ledger.length ? ledger.map(ledgerRow).join('') : emptyState('📋', 'لا توجد حركات بعد')}
    </div>

    <div class="section-title">
      سجل الرسائل
      ${smsLog.length ? `<span class="meta" style="font-weight:700;">✅ ${smsSent}${smsFailed ? ` &nbsp;|&nbsp; ❌ ${smsFailed}` : ''}</span>` : ''}
    </div>
    <div class="card" style="padding:6px 10px;">
      ${smsLog.length ? smsLog.map(smsLogRow).join('') : emptyState('✉️', 'لا توجد رسائل مُرسلة لهذا الزبون بعد')}
    </div>
  `;

  container.querySelector('#record-payment-btn').onclick = () => openRecordPaymentSheet(customer, balance, () => renderCustomerDetail(container, customerId));
  container.querySelector('#add-charge-btn').onclick = () => openAddChargeSheet(customer, () => renderCustomerDetail(container, customerId));

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

const SMS_STATUS_LABELS = { sent: 'تم الإرسال', failed: 'فشلت', pending: 'قيد الإرسال' };

function smsLogRow(entry) {
  const color = { sent: 'var(--success)', failed: 'var(--danger)', pending: 'var(--warning)' }[entry.status] || 'var(--text-muted)';
  const bg = { sent: 'var(--success-light)', failed: 'var(--danger-light)' }[entry.status] || 'var(--border)';
  return `
    <div class="list-item">
      <div class="avatar" style="background:${bg};color:${color};">📩</div>
      <div class="info">
        <div class="title">${escapeHtml((entry.message || '').slice(0, 45))}${(entry.message || '').length > 45 ? '...' : ''}</div>
        <div class="subtitle">${formatDateTime(entry.sent_at || entry.created_at)}</div>
        ${entry.error ? `<div class="meta" style="color:var(--danger);">${escapeHtml(entry.error)}</div>` : ''}
      </div>
      <div class="meta" style="color:${color};font-weight:700;">${SMS_STATUS_LABELS[entry.status] || entry.status}</div>
    </div>`;
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
    const btn = overlay.querySelector('#ec-save');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      await db.updateCustomer(customer.id, {
        name, phone: overlay.querySelector('#ec-phone').value.trim(), notes: overlay.querySelector('#ec-notes').value.trim(),
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

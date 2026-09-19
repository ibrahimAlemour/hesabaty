// إدارة المحلات: القائمة، البحث، الإضافة، التفاصيل، الاشتراك، الدفعات، التعليق/التفعيل
import * as adb from './admin-db.js';
import { getCurrentAdmin } from './admin-auth.js';
import {
  formatMoney, formatDate, formatDateTime, toCents, fromCents, escapeHtml, fuzzyMatch, debounce,
  computeShopStatus, statusLabel, statusIcon, daysUntil
} from './admin-utils.js';
import { toastError, toastSuccess, setLoading, openSheet, closeSheet, confirmDialog, emptyState } from '../../js/ui.js';

let cachedQuery = '';

export async function renderShopsList(container) {
  container.innerHTML = `<div class="skeleton" style="height:300px;"></div>`;
  const [shops, latestSubs, adminSettings] = await Promise.all([adb.listShops(), adb.getAllLatestSubscriptions(), adb.getAdminSettings()]);
  const grace = (adminSettings && adminSettings.grace_period_days) || 7;
  const enriched = shops.map(s => ({ ...s, sub: latestSubs.get(s.id) || null, computedStatus: computeShopStatus(s, latestSubs.get(s.id), grace) }));
  render(container, enriched, cachedQuery);
}

function render(container, shops, query) {
  const filtered = query ? shops.filter(s => fuzzyMatch(s.name, query) || (s.phone && s.phone.includes(query)) || fuzzyMatch(s.owner_name || '', query)) : shops;

  container.innerHTML = `
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input type="text" id="shop-search" placeholder="ابحث بالاسم أو رقم الهاتف..." value="${escapeHtml(query)}">
    </div>
    <button class="btn btn-primary btn-block" id="add-shop-btn" style="margin-bottom:14px;">+ إضافة محل جديد</button>
    <div class="card" style="padding:6px 10px;">
      ${filtered.length ? filtered.map(shopRow).join('') : emptyState('🏪', 'لا توجد محلات مطابقة')}
    </div>
  `;
  container.querySelector('#shop-search').oninput = debounce((e) => { cachedQuery = e.target.value; render(container, shops, cachedQuery); }, 150);
  container.querySelector('#add-shop-btn').onclick = () => openCreateShopSheet(container);
  container.querySelectorAll('[data-open]').forEach(el => el.onclick = () => window.location.hash = `#/shops/${el.dataset.open}`);
}

function shopRow(s) {
  return `
    <div class="admin-table-row" data-open="${s.id}">
      <div class="avatar">${escapeHtml((s.name || '?')[0])}</div>
      <div class="info" style="flex:1;">
        <div class="shop-name">${escapeHtml(s.name)}</div>
        <div class="shop-meta">${escapeHtml(s.owner_name || '')} ${s.phone ? '- ' + escapeHtml(s.phone) : ''}</div>
        <div class="shop-meta">تاريخ التسجيل: ${formatDate(s.created_at)}${s.sub ? ' - سعر الاشتراك: ' + formatMoney(s.sub.monthly_price) : ''}</div>
      </div>
      <span class="badge status-${s.computedStatus}">${statusIcon(s.computedStatus)} ${statusLabel(s.computedStatus)}</span>
    </div>`;
}

function openCreateShopSheet(container) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>+ إضافة محل جديد</h3></div>
    <div class="form-group"><label>اسم المحل</label><input type="text" id="ns-name" placeholder="مثال: ملحمة أبو محمد"></div>
    <div class="form-group"><label>اسم صاحب المحل</label><input type="text" id="ns-owner" placeholder="الاسم"></div>
    <div class="form-group"><label>رقم الهاتف</label><input type="tel" id="ns-phone" placeholder="05xxxxxxxx"></div>
    <div class="form-group"><label>العنوان (اختياري)</label><input type="text" id="ns-address"></div>
    <div class="divider-label">حساب دخول صاحب المحل</div>
    <div class="form-group"><label>البريد الإلكتروني</label><input type="email" id="ns-email" placeholder="owner@example.com"></div>
    <div class="form-group">
      <label>كلمة المرور</label>
      <div style="display:flex;gap:8px;">
        <input type="text" id="ns-password" placeholder="6 أحرف على الأقل" style="flex:1;">
        <button type="button" class="btn btn-secondary btn-sm" id="ns-gen-pass">توليد</button>
      </div>
    </div>
    <div class="divider-label">تفاصيل الاشتراك الأول</div>
    <div class="form-group"><label>قيمة الاشتراك الشهري (₪)</label><input type="number" id="ns-price" step="0.5" min="0" placeholder="100"></div>
    <div class="form-group"><label>عدد الأشهر</label><input type="number" id="ns-months" value="1" min="1" step="1"></div>
    <button class="btn btn-primary btn-block" id="ns-save">إنشاء المحل وحساب الدخول</button>
  `, { onOpen: (el) => el.querySelector('#ns-name').focus() });

  overlay.querySelector('#ns-gen-pass').onclick = () => {
    const pass = Math.random().toString(36).slice(-5) + Math.floor(10 + Math.random() * 89);
    overlay.querySelector('#ns-password').value = pass;
  };

  overlay.querySelector('#ns-save').onclick = async () => {
    const btn = overlay.querySelector('#ns-save');
    const name = overlay.querySelector('#ns-name').value.trim();
    const ownerEmail = overlay.querySelector('#ns-email').value.trim();
    const ownerPassword = overlay.querySelector('#ns-password').value;
    if (!name) return toastError('أدخل اسم المحل');
    if (!ownerEmail) return toastError('أدخل بريد صاحب المحل');
    if (!ownerPassword || ownerPassword.length < 6) return toastError('كلمة المرور يجب أن تكون 6 أحرف على الأقل');
    const price = parseFloat(overlay.querySelector('#ns-price').value) || 0;
    const months = parseInt(overlay.querySelector('#ns-months').value) || 1;
    setLoading(btn, true, 'جاري الإنشاء...');
    try {
      const admin = await getCurrentAdmin();
      const result = await adb.createShopWithLogin({
        shopName: name, ownerName: overlay.querySelector('#ns-owner').value.trim(),
        phone: overlay.querySelector('#ns-phone').value.trim(), address: overlay.querySelector('#ns-address').value.trim(),
        monthlyPrice: price, months, ownerEmail, ownerPassword
      });
      await adb.logAdminAction(admin, 'create_shop', result.shop.id, { name, price, months, ownerEmail });
      closeSheet();
      openCreatedShopSuccessSheet(container, result);
    } catch (err) {
      console.error(err);
      toastError(err.message || 'حدث خطأ أثناء إنشاء المحل. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };
}

function openCreatedShopSuccessSheet(container, result) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>✅ تم إنشاء المحل بنجاح</h3></div>
    <p style="font-size:13.5px;color:var(--text-muted);margin-bottom:14px;">شارك بيانات الدخول التالية مع صاحب المحل (تظهر مرة واحدة فقط هنا):</p>
    <div class="card" style="background:var(--primary-light);">
      <div style="font-size:13px;color:var(--text-muted);">البريد الإلكتروني</div>
      <div style="font-weight:800;font-size:15px;margin-bottom:10px;">${escapeHtml(result.ownerEmail)}</div>
      <div style="font-size:13px;color:var(--text-muted);">كلمة المرور</div>
      <div style="font-weight:800;font-size:15px;">${escapeHtml(result.ownerPassword)}</div>
    </div>
    <button class="btn btn-primary btn-block" id="cs-done" style="margin-top:14px;">تم</button>
  `, { closeOnBackdrop: false });
  overlay.querySelector('#cs-done').onclick = () => {
    closeSheet();
    window.location.hash = `#/shops/${result.shop.id}`;
  };
}

// ---------- تفاصيل المحل ----------
export async function renderShopDetail(container, shopId) {
  container.innerHTML = `<div class="skeleton" style="height:300px;"></div>`;
  const [shop, subs, payments, adminSettings] = await Promise.all([
    adb.getShop(shopId), adb.getShopSubscriptions(shopId), adb.getShopPayments(shopId), adb.getAdminSettings()
  ]);
  if (!shop) { container.innerHTML = `<div class="card">المحل غير موجود</div>`; return; }
  const grace = (adminSettings && adminSettings.grace_period_days) || 7;
  const latestSub = subs[0] || null;
  const computedStatus = computeShopStatus(shop, latestSub, grace);

  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);

  container.innerHTML = `
    <div class="card admin-detail-header">
      <div style="font-size:36px;">🏪</div>
      <div class="shop-title">${escapeHtml(shop.name)}</div>
      <div class="shop-sub">${escapeHtml(shop.owner_name || '')} ${shop.phone ? '- ' + escapeHtml(shop.phone) : ''}</div>
      <div style="margin-top:8px;"><span class="badge status-${computedStatus}" style="font-size:13px;padding:6px 14px;">${statusIcon(computedStatus)} ${statusLabel(computedStatus)}</span></div>
    </div>

    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">💰 الاشتراك الشهري</div><div class="stat-value">${latestSub ? formatMoney(latestSub.monthly_price) : '—'}</div></div>
      <div class="stat-card"><div class="stat-label">📅 ينتهي في</div><div class="stat-value" style="font-size:15px;">${latestSub ? latestSub.end_date : '—'}</div></div>
      <div class="stat-card cash"><div class="stat-label">✅ إجمالي المدفوع</div><div class="stat-value">${formatMoney(totalPaid)}</div></div>
      <div class="stat-card"><div class="stat-label">🗓️ تاريخ التسجيل</div><div class="stat-value" style="font-size:15px;">${formatDate(shop.created_at)}</div></div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
      <button class="btn btn-primary" id="renew-btn">🔄 تجديد / إضافة فترة</button>
      <button class="btn btn-secondary" id="record-payment-btn">💵 تسجيل دفعة</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
      <button class="btn btn-outline" id="edit-shop-btn">تعديل بيانات المحل</button>
      ${shop.status === 'suspended'
        ? `<button class="btn btn-success" id="toggle-status-btn">✅ إعادة تفعيل</button>`
        : `<button class="btn btn-danger" id="toggle-status-btn">🔒 تعليق الحساب</button>`}
    </div>

    <div class="section-title">سجل فترات الاشتراك</div>
    <div class="card" style="padding:6px 10px;">
      ${subs.length ? subs.map(subRow).join('') : emptyState('📅', 'لا يوجد اشتراك مسجّل بعد')}
    </div>

    <div class="section-title">سجل الدفعات</div>
    <div class="card" style="padding:6px 10px;">
      ${payments.length ? payments.map(paymentRow).join('') : emptyState('💵', 'لا توجد دفعات مسجّلة بعد')}
    </div>
  `;

  container.querySelector('#renew-btn').onclick = () => openRenewSheet(container, shop, latestSub);
  container.querySelector('#record-payment-btn').onclick = () => openRecordPaymentSheet(container, shop, latestSub);
  container.querySelector('#edit-shop-btn').onclick = () => openEditShopSheet(container, shop);
  container.querySelector('#toggle-status-btn').onclick = () => toggleShopStatus(container, shop);
}

function subRow(sub) {
  const days = daysUntil(sub.end_date);
  return `
    <div class="list-item">
      <div class="avatar" style="background:var(--primary-light);color:var(--primary-dark);">📅</div>
      <div class="info">
        <div class="title">${sub.start_date} → ${sub.end_date}</div>
        <div class="subtitle">${formatMoney(sub.monthly_price)}/شهريًا ${sub.notes ? '- ' + escapeHtml(sub.notes) : ''}</div>
      </div>
      <div class="meta" style="color:${days >= 0 ? 'var(--success)' : 'var(--danger)'};">${days >= 0 ? `باقي ${days} يوم` : `منتهي منذ ${Math.abs(days)} يوم`}</div>
    </div>`;
}

function paymentRow(p) {
  const methodLabel = { cash: 'نقدي', transfer: 'تحويل', other: 'أخرى' }[p.method] || p.method;
  return `
    <div class="list-item">
      <div class="avatar" style="background:var(--success-light);color:var(--success);">💵</div>
      <div class="info">
        <div class="title">${formatMoney(p.amount)} <span class="badge ${p.method === 'cash' ? 'cash' : 'transfer'}">${methodLabel}</span></div>
        <div class="subtitle">${formatDateTime(p.paid_at)} ${p.period_from ? `- يغطي: ${p.period_from} إلى ${p.period_to || '—'}` : ''}</div>
        ${p.notes ? `<div class="subtitle">${escapeHtml(p.notes)}</div>` : ''}
      </div>
    </div>`;
}

function openRenewSheet(container, shop, latestSub) {
  const defaultPrice = latestSub ? fromCents(latestSub.monthly_price) : 0;
  const baseDate = latestSub && daysUntil(latestSub.end_date) > 0 ? new Date(latestSub.end_date) : new Date();

  const overlay = openSheet(`
    <div class="sheet-header"><h3>تجديد / إضافة فترة اشتراك</h3></div>
    <div class="form-group"><label>قيمة الاشتراك الشهري (₪)</label><input type="number" id="rn-price" step="0.5" min="0" value="${defaultPrice}"></div>
    <div class="form-group"><label>تاريخ البداية</label><input type="date" id="rn-start" value="${baseDate.toISOString().slice(0, 10)}"></div>
    <div class="form-group"><label>عدد الأشهر</label><input type="number" id="rn-months" value="1" min="1" step="1"></div>
    <div class="form-group"><label>ملاحظات (اختياري)</label><textarea id="rn-notes"></textarea></div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;margin-bottom:16px;">
      <input type="checkbox" id="rn-reactivate" ${shop.status === 'suspended' ? 'checked' : ''}> إعادة تفعيل الحساب فورًا
    </label>
    <button class="btn btn-primary btn-block" id="rn-save">حفظ التجديد</button>
  `);

  overlay.querySelector('#rn-save').onclick = async () => {
    const btn = overlay.querySelector('#rn-save');
    const price = parseFloat(overlay.querySelector('#rn-price').value) || 0;
    const months = parseInt(overlay.querySelector('#rn-months').value) || 1;
    const startDate = overlay.querySelector('#rn-start').value;
    if (!startDate) return toastError('أدخل تاريخ البداية');
    const end = new Date(startDate); end.setMonth(end.getMonth() + months);
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      const admin = await getCurrentAdmin();
      await adb.addSubscriptionPeriod({
        shopId: shop.id, monthlyPrice: toCents(price), startDate,
        endDate: end.toISOString().slice(0, 10), notes: overlay.querySelector('#rn-notes').value.trim()
      });
      if (overlay.querySelector('#rn-reactivate').checked && shop.status === 'suspended') {
        await adb.setShopStatus(shop.id, 'active');
      }
      await adb.logAdminAction(admin, 'update_subscription', shop.id, { price, months, startDate });
      closeSheet();
      toastSuccess('تم تجديد الاشتراك');
      renderShopDetail(container, shop.id);
    } catch (err) {
      toastError('حدث خطأ أثناء الحفظ. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };
}

function openRecordPaymentSheet(container, shop, latestSub) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>تسجيل دفعة - ${escapeHtml(shop.name)}</h3></div>
    <div class="form-group"><label>المبلغ (₪)</label><input type="number" id="pp-amount" step="0.5" min="0" value="${latestSub ? fromCents(latestSub.monthly_price) : ''}"></div>
    <div class="form-group">
      <label>طريقة الدفع</label>
      <div class="pay-methods">
        <div class="pay-method-btn active" data-method="cash"><span class="emoji">💵</span>نقدي</div>
        <div class="pay-method-btn" data-method="transfer"><span class="emoji">📱</span>تحويل</div>
        <div class="pay-method-btn" data-method="other"><span class="emoji">📝</span>أخرى</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;">
      <div class="form-group" style="flex:1;"><label>الفترة من</label><input type="date" id="pp-from" value="${latestSub ? latestSub.start_date : ''}"></div>
      <div class="form-group" style="flex:1;"><label>الفترة إلى</label><input type="date" id="pp-to" value="${latestSub ? latestSub.end_date : ''}"></div>
    </div>
    <div class="form-group"><label>ملاحظات (اختياري)</label><textarea id="pp-notes"></textarea></div>
    <button class="btn btn-primary btn-block" id="pp-save">حفظ الدفعة</button>
  `, { onOpen: (el) => el.querySelector('#pp-amount').focus() });

  let method = 'cash';
  overlay.querySelectorAll('.pay-method-btn').forEach(btn => btn.onclick = () => {
    method = btn.dataset.method;
    overlay.querySelectorAll('.pay-method-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  });

  overlay.querySelector('#pp-save').onclick = async () => {
    const btn = overlay.querySelector('#pp-save');
    const amount = parseFloat(overlay.querySelector('#pp-amount').value);
    if (!amount || amount <= 0) return toastError('أدخل مبلغًا صحيحًا');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      const admin = await getCurrentAdmin();
      const payment = await adb.addPayment({
        shopId: shop.id, subscriptionId: latestSub ? latestSub.id : null, amount: toCents(amount), method,
        periodFrom: overlay.querySelector('#pp-from').value || null, periodTo: overlay.querySelector('#pp-to').value || null,
        notes: overlay.querySelector('#pp-notes').value.trim()
      });
      await adb.logAdminAction(admin, 'record_payment', shop.id, { amount, method });
      closeSheet();
      toastSuccess('تم تسجيل الدفعة');
      renderShopDetail(container, shop.id);
    } catch (err) {
      toastError('حدث خطأ أثناء حفظ الدفعة. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };
}

function openEditShopSheet(container, shop) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>تعديل بيانات المحل</h3></div>
    <div class="form-group"><label>اسم المحل</label><input type="text" id="es-name" value="${escapeHtml(shop.name)}"></div>
    <div class="form-group"><label>اسم صاحب المحل</label><input type="text" id="es-owner" value="${escapeHtml(shop.owner_name || '')}"></div>
    <div class="form-group"><label>رقم الهاتف</label><input type="tel" id="es-phone" value="${escapeHtml(shop.phone || '')}"></div>
    <div class="form-group"><label>العنوان</label><input type="text" id="es-address" value="${escapeHtml(shop.address || '')}"></div>
    <div class="form-group"><label>ملاحظات</label><textarea id="es-notes">${escapeHtml(shop.notes || '')}</textarea></div>
    <button class="btn btn-primary btn-block" id="es-save">حفظ التعديلات</button>
  `);
  overlay.querySelector('#es-save').onclick = async () => {
    const name = overlay.querySelector('#es-name').value.trim();
    if (!name) return toastError('أدخل اسم المحل');
    const btn = overlay.querySelector('#es-save');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      await adb.updateShop(shop.id, {
        name, owner_name: overlay.querySelector('#es-owner').value.trim(),
        phone: overlay.querySelector('#es-phone').value.trim(), address: overlay.querySelector('#es-address').value.trim(),
        notes: overlay.querySelector('#es-notes').value.trim()
      });
      closeSheet();
      toastSuccess('تم تحديث بيانات المحل');
      renderShopDetail(container, shop.id);
    } catch (err) {
      toastError('حدث خطأ أثناء الحفظ. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };
}

async function toggleShopStatus(container, shop) {
  const suspending = shop.status !== 'suspended';
  const ok = await confirmDialog({
    title: suspending ? 'تعليق الحساب' : 'إعادة تفعيل الحساب',
    message: suspending
      ? `سيتم منع "${shop.name}" من استخدام التطبيق حتى تعيد تفعيله. لن تُحذف أي بيانات.`
      : `سيتم السماح لـ "${shop.name}" باستخدام التطبيق مرة أخرى فورًا.`,
    confirmLabel: suspending ? 'تعليق' : 'تفعيل',
    danger: suspending
  });
  if (!ok) return;
  try {
    const admin = await getCurrentAdmin();
    await adb.setShopStatus(shop.id, suspending ? 'suspended' : 'active');
    await adb.logAdminAction(admin, suspending ? 'suspend' : 'reactivate', shop.id, {});
    toastSuccess(suspending ? 'تم تعليق الحساب' : 'تم تفعيل الحساب');
    renderShopDetail(container, shop.id);
  } catch (err) {
    toastError('حدث خطأ أثناء تنفيذ العملية. حاول مرة أخرى.');
  }
}

// الإعدادات: بيانات المحل، المستخدمون، النسخ الاحتياطي، الاتصال بسوبابيس، الوضع الليلي
import * as db from './database.js';
import * as remoteDb from './db-supabase.js';
import {
  getCurrentUser, canDelete, addCashierAccount, removeUser, signOut,
  createSupabaseCashier, deleteSupabaseCashier, getSupabaseCashiers,
  getCashierEmail, resetCashierPassword, updateCashierName
} from './auth.js';
import { getPendingCount, getPendingItems, flushQueue, discardItem } from './sync.js';
import { escapeHtml, formatDateTime } from './utils.js';
import { toastError, toastSuccess, setLoading, openSheet, closeSheet, confirmDialog } from './ui.js';
import { SAAS_SUPABASE_URL, SAAS_SUPABASE_ANON_KEY } from './saas-config.js';
import { wireInstallButton, showIOSInstallInstructions } from './pwa-install.js';

export async function renderSettings(container) {
  container.innerHTML = `<div class="skeleton" style="height:300px;"></div>`;
  const [settings, user, pendingSync] = await Promise.all([db.getSettings(), getCurrentUser(), getPendingCount()]);
  const canManage = canDelete(user);
  const pendingItems = pendingSync ? await getPendingItems() : [];
  const stuckItem = pendingItems.find(i => i.lastError);
  const stuckError = stuckItem?.lastError;
  // نجلب auth.uid() الفعلي فقط عند وجود عملية عالقة (لتشخيص مشاكل RLS)، وليس بكل فتح للشاشة
  const liveAuthUid = stuckError && settings.backendMode === 'supabase' ? await remoteDb.getCurrentAuthUserId() : null;
  const isSupabase = settings.backendMode === 'supabase';
  const supabaseCashiers = canManage && isSupabase ? await getSupabaseCashiers().catch(() => []) : [];

  container.innerHTML = `
    <div class="card">
      <div class="section-title" style="margin-top:0;">تثبيت التطبيق</div>
      <p style="font-size:12.5px;color:var(--text-muted);margin-top:-6px;">ثبّت التطبيق على شاشتك الرئيسية ليفتح ويعمل كتطبيق مستقل.</p>
      <button class="btn btn-outline btn-block" id="pwa-install-btn" style="display:none;">📲 تثبيت التطبيق على الجهاز</button>
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0;">بيانات المحل</div>
      <div class="form-group"><label>اسم المحل</label><input type="text" id="st-shop-name" value="${escapeHtml(settings.shopName)}"></div>
      <div class="form-group"><label>رقم الهاتف</label><input type="tel" id="st-phone" value="${escapeHtml(settings.phone || '')}"></div>
      <div class="form-group"><label>العنوان</label><input type="text" id="st-address" value="${escapeHtml(settings.address || '')}"></div>
      <div class="form-group">
        <label>المنطقة الزمنية</label>
        <select id="st-timezone">
          ${['Asia/Gaza', 'Asia/Jerusalem', 'Asia/Amman', 'UTC'].map(tz => `<option value="${tz}" ${settings.timezone === tz ? 'selected' : ''}>${tz}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn-primary btn-block" id="st-save-shop">حفظ</button>
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0;">المظهر</div>
      <div class="tabs">
        ${[['auto','تلقائي'],['light','فاتح'],['dark','داكن']].map(([k,l]) => `<button class="tab-btn ${settings.theme===k?'active':''}" data-theme="${k}">${l}</button>`).join('')}
      </div>
    </div>

    ${canManage && !isSupabase ? `
    <div class="card">
      <div class="section-title" style="margin-top:0;">إدارة المستخدمين</div>
      <ul>
        ${(settings.users || []).map(u => `
          <li class="list-item">
            <div class="avatar">${u.role === 'owner' ? '👑' : '👤'}</div>
            <div class="info"><div class="title">${escapeHtml(u.name)}</div><div class="subtitle">${u.role === 'owner' ? 'صاحب المحل' : 'كاشير'}</div></div>
            ${u.role !== 'owner' ? `<button class="remove-btn" data-remove-user="${u.id}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>` : ''}
          </li>`).join('')}
      </ul>
      <button class="btn btn-secondary btn-block" id="st-add-cashier" style="margin-top:10px;">+ إضافة حساب كاشير</button>
    </div>
    ` : ''}

    ${canManage && isSupabase ? `
    <div class="card">
      <div class="section-title" style="margin-top:0;">إدارة المستخدمين (الكاشير)</div>
      <p style="font-size:12px;color:var(--text-muted);margin-top:-6px;">حساب كاشير يسجّل دخوله بالبريد وكلمة المرور من أي جهاز، لكن بدون رؤية الأرباح أو صلاحية الحذف.</p>
      <ul>
        ${supabaseCashiers.length ? supabaseCashiers.map(c => `
          <li class="list-item">
            <div class="avatar">👤</div>
            <div class="info"><div class="title">${escapeHtml(c.name)}</div><div class="subtitle">كاشير</div></div>
            <button class="remove-btn" data-edit-cashier="${c.id}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
            <button class="remove-btn" data-remove-cashier="${c.id}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>
          </li>`).join('') : `<li class="list-item"><div class="info"><div class="subtitle">لا يوجد حسابات كاشير بعد</div></div></li>`}
      </ul>
      <button class="btn btn-secondary btn-block" id="st-add-cashier-supabase" style="margin-top:10px;">+ إضافة حساب كاشير</button>
    </div>
    ` : ''}

    ${canManage ? `

    <div class="card">
      <div class="section-title" style="margin-top:0;">النسخ الاحتياطي</div>
      <button class="btn btn-outline btn-block" id="st-export">⬇️ تصدير نسخة احتياطية (JSON)</button>
      <button class="btn btn-outline btn-block" style="margin-top:8px;" id="st-import">⬆️ استيراد نسخة احتياطية</button>
      <input type="file" id="st-import-file" accept="application/json" style="display:none;">
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0;">${settings.backendMode === 'supabase' ? 'حالة الاتصال والمزامنة' : 'اتصال Supabase'}</div>
      ${settings.sessionInvalid ? `
      <div style="background:var(--danger-light);border-radius:10px;padding:10px;margin-bottom:10px;">
        <p style="font-size:13px;color:var(--danger);font-weight:700;margin:0;">⚠️ جلسة الدخول انتهت أو تعطّلت</p>
        <p style="font-size:12px;color:var(--danger);margin:6px 0 0;">بياناتك محفوظة على جهازك بأمان، لكن ما بترفع للخادم حاليًا. سجّل الخروج من الأسفل ثم سجّل الدخول من جديد بحسابك لحل المشكلة.</p>
      </div>` : ''}
      ${settings.backendMode === 'supabase' ? '' : `
      <p style="font-size:12.5px;color:var(--text-muted);margin-top:-6px;">اختياري. اتركه فارغًا للعمل محليًا بدون إنترنت.</p>
      <div class="form-group"><label>Supabase URL</label><input type="text" id="st-sb-url" value="${escapeHtml(settings.supabaseUrl || SAAS_SUPABASE_URL || '')}" placeholder="https://xxxx.supabase.co"></div>
      <div class="form-group"><label>Supabase Anon Key</label><input type="text" id="st-sb-key" value="${escapeHtml(settings.supabaseAnonKey || SAAS_SUPABASE_ANON_KEY || '')}" placeholder="anon key العلني فقط"></div>
      <button class="btn btn-primary btn-block" id="st-sb-test">اختبار الاتصال والتفعيل</button>
      `}
      <div style="font-size:13px;margin-top:10px;">
        حالة المزامنة: <b>${settings.backendMode === 'supabase' ? (navigator.onLine ? 'متصل' : 'غير متصل - وضع محلي') : 'محلي فقط'}</b>
        ${pendingSync ? ` - عمليات معلقة: <b style="color:var(--danger);">${pendingSync}</b>` : ''}
      </div>
      ${stuckError ? `
      <p style="font-size:12px;color:var(--danger);margin-top:8px;">تعذّر رفع بعض العمليات: ${escapeHtml(stuckError)}</p>
      <p style="font-size:10.5px;color:var(--text-muted);margin-top:4px;word-break:break-all;">تشخيص: shop_id بالعملية = ${escapeHtml(String(stuckItem.payload?.shop_id))} | shop_id الحالي = ${escapeHtml(String(settings.currentShopId))} | الجدول = ${escapeHtml(stuckItem.storeName)} | العملية = ${escapeHtml(stuckItem.operation)} | المحاولات = ${stuckItem.attempts} | آخر محاولة = ${stuckItem.lastAttemptAt ? formatDateTime(stuckItem.lastAttemptAt) : '—'}</p>
      <p style="font-size:10.5px;color:var(--primary-dark);font-weight:700;margin-top:4px;word-break:break-all;">auth.uid() الفعلي لهذه الجلسة الآن = ${escapeHtml(String(liveAuthUid))}</p>
      <p style="font-size:10px;color:var(--text-muted);margin-top:2px;">قارن هذه القيمة بعمود id بجدول profiles بلوحة سوبابيس: يجب أن يطابق حساب المالك المرتبط بـshop_id الحالي أعلاه. لو اختلف، سجّل الخروج والدخول من جديد.</p>
      <pre style="font-size:9.5px;color:var(--text-muted);margin-top:4px;white-space:pre-wrap;word-break:break-all;background:var(--bg);padding:6px;border-radius:8px;max-height:120px;overflow-y:auto;">${escapeHtml(JSON.stringify(stuckItem.payload))}</pre>
      <button class="btn btn-outline btn-block" style="margin-top:8px;color:var(--danger);border-color:var(--danger);" id="st-discard-stuck">تجاهل هذه العملية العالقة نهائيًا</button>
      ` : ''}
      ${settings.backendMode === 'supabase' ? `<button class="btn btn-secondary btn-block" style="margin-top:8px;" id="st-sync-now">مزامنة الآن</button>` : ''}
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0;color:var(--danger);">منطقة الخطر</div>
      <button class="btn btn-danger btn-block" id="st-wipe">مسح جميع البيانات المحلية</button>
    </div>` : ''}

    <button class="btn btn-secondary btn-block" id="st-logout">تسجيل الخروج</button>
  `;

  bind(container, settings);
}

function bind(container, settings) {
  wireInstallButton(container.querySelector('#pwa-install-btn'), { onIOSInstructions: showIOSInstallInstructions });

  container.querySelector('#st-save-shop').onclick = async () => {
    const btn = container.querySelector('#st-save-shop');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      await db.updateSettings({
        shopName: container.querySelector('#st-shop-name').value.trim() || settings.shopName,
        phone: container.querySelector('#st-phone').value.trim(),
        address: container.querySelector('#st-address').value.trim(),
        timezone: container.querySelector('#st-timezone').value
      });
      toastSuccess('تم حفظ بيانات المحل');
    } catch (e) { toastError('حدث خطأ أثناء الحفظ'); }
    setLoading(btn, false);
  };

  container.querySelectorAll('[data-theme]').forEach(btn => btn.onclick = async () => {
    await db.updateSettings({ theme: btn.dataset.theme });
    applyTheme(btn.dataset.theme);
    renderSettings(container);
  });

  const logoutBtn = container.querySelector('#st-logout');
  if (logoutBtn) logoutBtn.onclick = async () => {
    const ok = await confirmDialog({ title: 'تسجيل الخروج', message: 'هل تريد تسجيل الخروج؟', danger: false, confirmLabel: 'خروج' });
    if (!ok) return;
    await signOut();
    window.location.reload();
  };

  const addCashierBtn = container.querySelector('#st-add-cashier');
  if (addCashierBtn) addCashierBtn.onclick = () => openAddCashierSheet(container);

  const addCashierSupabaseBtn = container.querySelector('#st-add-cashier-supabase');
  if (addCashierSupabaseBtn) addCashierSupabaseBtn.onclick = () => openAddCashierSheetSupabase(container);

  container.querySelectorAll('[data-remove-user]').forEach(btn => btn.onclick = async () => {
    const ok = await confirmDialog({ title: 'حذف المستخدم', message: 'هل تريد حذف هذا الحساب؟' });
    if (!ok) return;
    await removeUser(btn.dataset.removeUser);
    toastSuccess('تم حذف الحساب');
    renderSettings(container);
  });

  container.querySelectorAll('[data-edit-cashier]').forEach(btn => btn.onclick = () => {
    const cashier = supabaseCashiers.find(c => c.id === btn.dataset.editCashier);
    if (cashier) openCashierDetailSheet(container, cashier);
  });

  container.querySelectorAll('[data-remove-cashier]').forEach(btn => btn.onclick = async () => {
    const ok = await confirmDialog({
      title: 'حذف حساب الكاشير',
      message: 'سيتعذّر على هذا الحساب تسجيل الدخول نهائيًا بعد الحذف. هل تريد الاستمرار؟',
      danger: true
    });
    if (!ok) return;
    try {
      await deleteSupabaseCashier(btn.dataset.removeCashier);
      toastSuccess('تم حذف حساب الكاشير');
      renderSettings(container);
    } catch (err) {
      toastError(err.message || 'فشل حذف حساب الكاشير');
    }
  });

  const exportBtn = container.querySelector('#st-export');
  if (exportBtn) exportBtn.onclick = async () => {
    const backup = await db.exportBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `hesabaty-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toastSuccess('تم تصدير النسخة الاحتياطية');
  };

  const importBtn = container.querySelector('#st-import');
  const importFile = container.querySelector('#st-import-file');
  if (importBtn) importBtn.onclick = () => importFile.click();
  if (importFile) importFile.onchange = async () => {
    const file = importFile.files[0];
    if (!file) return;
    const ok = await confirmDialog({ title: 'استيراد نسخة احتياطية', message: 'سيتم دمج البيانات المستوردة مع البيانات الحالية.', confirmLabel: 'استيراد', danger: false });
    if (!ok) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      await db.importBackup(json);
      toastSuccess('تم استيراد النسخة الاحتياطية بنجاح');
      window.location.reload();
    } catch (err) {
      toastError('ملف النسخة الاحتياطية غير صالح');
    }
  };

  const sbTestBtn = container.querySelector('#st-sb-test');
  if (sbTestBtn) sbTestBtn.onclick = () => testSupabaseConnection(container);

  const syncNowBtn = container.querySelector('#st-sync-now');
  if (syncNowBtn) syncNowBtn.onclick = async () => {
    setLoading(syncNowBtn, true, 'جاري المزامنة...');
    await flushQueue();
    const remaining = await getPendingCount();
    if (!remaining) toastSuccess('تمت مزامنة جميع العمليات بنجاح');
    else toastError(`ما زال في ${remaining} عملية معلّقة - تحقق من رسالة الخطأ بالأسفل`);
    renderSettings(container);
  };

  const discardStuckBtn = container.querySelector('#st-discard-stuck');
  if (discardStuckBtn) discardStuckBtn.onclick = async () => {
    const ok = await confirmDialog({
      title: 'تجاهل العملية العالقة',
      message: 'سيتم إسقاط هذا التعديل المعلّق نهائيًا دون رفعه للخادم. السجل نفسه يبقى محفوظًا على هذا الجهاز فقط. هل تريد الاستمرار؟',
      confirmLabel: 'تجاهل نهائيًا'
    });
    if (!ok) return;
    const items = await getPendingItems();
    const stuck = items.find(i => i.lastError);
    if (stuck) await discardItem(stuck.id);
    toastSuccess('تم تجاهل العملية العالقة');
    renderSettings(container);
  };

  const wipeBtn = container.querySelector('#st-wipe');
  if (wipeBtn) wipeBtn.onclick = async () => {
    const ok = await confirmDialog({ title: 'مسح جميع البيانات', message: 'سيتم حذف جميع البيانات المحلية بشكل نهائي. هذا الإجراء لا يمكن التراجع عنه.', confirmLabel: 'مسح نهائي' });
    if (!ok) return;
    await db.wipeLocalData();
    window.location.reload();
  };
}

async function testSupabaseConnection(container) {
  const btn = container.querySelector('#st-sb-test');
  const key = container.querySelector('#st-sb-key').value.trim();
  let url = container.querySelector('#st-sb-url').value.trim();
  url = url.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  if (!url || !key) return toastError('أدخل رابط ومفتاح Supabase');
  setLoading(btn, true, 'جاري الاختبار...');
  try {
    await remoteDb.loadSupabaseScript();
    const result = await remoteDb.testConnection({ url, anonKey: key });
    if (!result.ok) throw new Error(result.message);
    await db.updateSettings({ supabaseUrl: url, supabaseAnonKey: key, backendMode: 'supabase' });
    toastSuccess('تم الاتصال بنجاح! سجّل الخروج الآن وادخل بحساب Supabase الذي أنشأته لبدء المزامنة');
    renderSettings(container);
  } catch (err) {
    console.error('Supabase connection test failed', err);
    toastError(`فشل الاتصال: ${err.message || 'تحقق من الرابط والمفتاح'}`);
    setLoading(btn, false);
  }
}

function openAddCashierSheet(container) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>+ إضافة حساب كاشير</h3></div>
    <div class="form-group"><label>الاسم</label><input type="text" id="cs-name" placeholder="اسم الكاشير"></div>
    <div class="form-group"><label>رمز الدخول (PIN)</label><input type="password" id="cs-pin" inputmode="numeric" placeholder="4 أرقام على الأقل"></div>
    <p style="font-size:12px;color:var(--text-muted);margin-top:-6px;">الكاشير لا يستطيع رؤية الأرباح أو حذف البيانات.</p>
    <button class="btn btn-primary btn-block" id="cs-save">إضافة</button>
  `, { onOpen: (el) => el.querySelector('#cs-name').focus() });

  overlay.querySelector('#cs-save').onclick = async () => {
    const name = overlay.querySelector('#cs-name').value.trim();
    const pin = overlay.querySelector('#cs-pin').value;
    if (!name) return toastError('أدخل الاسم');
    if (pin.length < 4) return toastError('رمز الدخول يجب أن يكون 4 أرقام على الأقل');
    await addCashierAccount({ name, pin });
    closeSheet();
    toastSuccess('تم إضافة حساب الكاشير');
    renderSettings(container);
  };
}

async function copyToClipboard(text, label) {
  if (!text) return;
  try { await navigator.clipboard.writeText(text); toastSuccess(`تم نسخ ${label}`); }
  catch (e) { toastError('تعذّر النسخ'); }
}

function openAddCashierSheetSupabase(container) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>+ إضافة حساب كاشير</h3></div>
    <div class="form-group"><label>الاسم</label><input type="text" id="cs-name" placeholder="اسم الكاشير"></div>
    <div class="form-group"><label>البريد الإلكتروني</label><input type="email" id="cs-email" placeholder="example@mail.com"></div>
    <div class="form-group"><label>كلمة المرور</label><input type="password" id="cs-password" placeholder="6 أحرف على الأقل"></div>
    <p style="font-size:12px;color:var(--text-muted);margin-top:-6px;">الكاشير يسجّل دخوله بهذا البريد وكلمة المرور من أي جهاز، ولا يستطيع رؤية الأرباح أو حذف البيانات.</p>
    <button class="btn btn-primary btn-block" id="cs-save">إضافة</button>
  `, { onOpen: (el) => el.querySelector('#cs-name').focus() });

  overlay.querySelector('#cs-save').onclick = async () => {
    const btn = overlay.querySelector('#cs-save');
    const name = overlay.querySelector('#cs-name').value.trim();
    const email = overlay.querySelector('#cs-email').value.trim();
    const password = overlay.querySelector('#cs-password').value;
    if (!name) return toastError('أدخل الاسم');
    if (!email) return toastError('أدخل البريد الإلكتروني');
    if (password.length < 6) return toastError('كلمة المرور يجب أن تكون 6 أحرف على الأقل');
    setLoading(btn, true, 'جاري الإضافة...');
    try {
      await createSupabaseCashier({ name, email, password });
      showCashierCreatedSheet({ name, email, password });
      toastSuccess('تم إضافة حساب الكاشير');
      renderSettings(container);
    } catch (err) {
      toastError(err.message || 'فشل إضافة حساب الكاشير');
      setLoading(btn, false);
    }
  };
}

function showCashierCreatedSheet({ name, email, password }) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>تم إنشاء حساب ${escapeHtml(name)}</h3></div>
    <p style="font-size:13px;color:var(--text-muted);">شارك هذه البيانات مع الكاشير ليسجّل دخوله بها. كلمة المرور لن تظهر مرة أخرى بعد إغلاق هذه الشاشة.</p>
    <div class="form-group"><label>البريد الإلكتروني</label><input type="text" id="cc-email" value="${escapeHtml(email)}" readonly></div>
    <div class="form-group"><label>كلمة المرور</label><input type="text" id="cc-password" value="${escapeHtml(password)}" readonly></div>
    <button class="btn btn-outline btn-block" id="cc-copy">نسخ البريد وكلمة المرور</button>
    <button class="btn btn-primary btn-block" style="margin-top:8px;" id="cc-close">تم</button>
  `, { closeOnBackdrop: false });

  overlay.querySelector('#cc-copy').onclick = () => copyToClipboard(`${email}\n${password}`, 'بيانات الدخول');
  overlay.querySelector('#cc-close').onclick = () => closeSheet();
}

const COPY_ICON_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>`;

function openCashierDetailSheet(container, cashier) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>بيانات الكاشير</h3></div>
    <div class="form-group"><label>الاسم</label><input type="text" id="cd-name" value="${escapeHtml(cashier.name)}"></div>
    <button class="btn btn-primary btn-block" id="cd-save-name">حفظ الاسم</button>

    <div class="divider-label">حساب الدخول</div>
    <div class="form-group">
      <label>البريد الإلكتروني</label>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="text" id="cd-email" value="جاري التحميل..." readonly style="flex:1;">
        <button type="button" class="icon-btn" id="cd-copy-email" title="نسخ البريد">${COPY_ICON_SVG}</button>
      </div>
    </div>
    <div class="form-group">
      <label>كلمة المرور</label>
      <p class="hint" style="margin:0 0 8px;">كلمة المرور الحالية غير قابلة للعرض أبدًا لأي جهة (تُخزَّن مُشفّرة). يمكنك بدلًا من ذلك تعيين كلمة مرور جديدة:</p>
      <input type="text" id="cd-new-password" placeholder="كلمة مرور جديدة (6 أحرف على الأقل)">
      <button type="button" class="btn btn-outline btn-block" style="margin-top:8px;" id="cd-reset-pass">تعيين كلمة المرور الجديدة</button>
      <div id="cd-pass-result" style="display:none;margin-top:10px;background:var(--primary-light);border-radius:10px;padding:10px;">
        <div style="font-size:12px;color:var(--text-muted);">تم تعيين كلمة المرور الجديدة - شاركها مع الكاشير الآن، لن تظهر مرة أخرى:</div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:6px;">
          <div id="cd-pass-value" style="font-weight:800;font-size:15px;flex:1;"></div>
          <button type="button" class="icon-btn" id="cd-copy-pass" title="نسخ كلمة المرور">${COPY_ICON_SVG}</button>
        </div>
      </div>
    </div>
  `);

  const emailInput = overlay.querySelector('#cd-email');
  getCashierEmail(cashier.id).then(email => { emailInput.value = email || 'لا يوجد بريد'; })
    .catch(err => { emailInput.value = 'تعذّر جلب البريد'; console.error(err); });
  overlay.querySelector('#cd-copy-email').onclick = () => copyToClipboard(emailInput.value, 'البريد الإلكتروني');

  overlay.querySelector('#cd-save-name').onclick = async () => {
    const name = overlay.querySelector('#cd-name').value.trim();
    if (!name) return toastError('أدخل الاسم');
    const btn = overlay.querySelector('#cd-save-name');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      await updateCashierName(cashier.id, name);
      toastSuccess('تم تحديث الاسم');
      renderSettings(container);
    } catch (err) {
      toastError(err.message || 'فشل تحديث الاسم');
      setLoading(btn, false);
    }
  };

  overlay.querySelector('#cd-reset-pass').onclick = async () => {
    const newPassword = overlay.querySelector('#cd-new-password').value;
    if (!newPassword || newPassword.length < 6) return toastError('كلمة المرور يجب أن تكون 6 أحرف على الأقل');
    const ok = await confirmDialog({
      title: 'تعيين كلمة مرور جديدة',
      message: 'كلمة مرور الكاشير الحالية ستصبح غير صالحة فورًا، ولن يمكن التراجع عن هذا الإجراء. هل تريد الاستمرار؟',
      confirmLabel: 'تعيين كلمة المرور'
    });
    if (!ok) return;
    const btn = overlay.querySelector('#cd-reset-pass');
    setLoading(btn, true, 'جاري التحديث...');
    try {
      await resetCashierPassword(cashier.id, newPassword);
      overlay.querySelector('#cd-pass-value').textContent = newPassword;
      overlay.querySelector('#cd-pass-result').style.display = '';
      overlay.querySelector('#cd-copy-pass').onclick = () => copyToClipboard(newPassword, 'كلمة المرور');
      toastSuccess('تم تعيين كلمة المرور الجديدة');
    } catch (err) {
      toastError(err.message || 'فشل تحديث كلمة المرور');
    }
    setLoading(btn, false);
  };
}

export function applyTheme(theme) {
  document.body.classList.remove('theme-auto', 'theme-dark', 'theme-light');
  document.body.classList.add(`theme-${theme}`);
}

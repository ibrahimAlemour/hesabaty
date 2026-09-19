// الإعدادات: بيانات المحل، المستخدمون، النسخ الاحتياطي، الاتصال بسوبابيس، الوضع الليلي
import * as db from './database.js';
import * as remoteDb from './db-supabase.js';
import { getCurrentUser, canDelete, addCashierAccount, removeUser, signOut } from './auth.js';
import { getPendingCount, getPendingItems, flushQueue } from './sync.js';
import { escapeHtml } from './utils.js';
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

    ${canManage ? `
    <div class="card">
      <div class="section-title" style="margin-top:0;">إدارة المستخدمين</div>
      ${settings.backendMode === 'supabase' ? `
      <p style="font-size:12.5px;color:var(--text-muted);">التطبيق متصل بسوبابيس الآن، فإضافة الحسابات تتم من لوحة Supabase مباشرة: Authentication → Add user، ثم أضف صفًا مطابقًا بجدول profiles بدور "cashier".</p>
      ` : `
      <ul>
        ${(settings.users || []).map(u => `
          <li class="list-item">
            <div class="avatar">${u.role === 'owner' ? '👑' : '👤'}</div>
            <div class="info"><div class="title">${escapeHtml(u.name)}</div><div class="subtitle">${u.role === 'owner' ? 'صاحب المحل' : 'كاشير'}</div></div>
            ${u.role !== 'owner' ? `<button class="remove-btn" data-remove-user="${u.id}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>` : ''}
          </li>`).join('')}
      </ul>
      <button class="btn btn-secondary btn-block" id="st-add-cashier" style="margin-top:10px;">+ إضافة حساب كاشير</button>
      `}
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0;">النسخ الاحتياطي</div>
      <button class="btn btn-outline btn-block" id="st-export">⬇️ تصدير نسخة احتياطية (JSON)</button>
      <button class="btn btn-outline btn-block" style="margin-top:8px;" id="st-import">⬆️ استيراد نسخة احتياطية</button>
      <input type="file" id="st-import-file" accept="application/json" style="display:none;">
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0;">اتصال Supabase</div>
      <p style="font-size:12.5px;color:var(--text-muted);margin-top:-6px;">اختياري. اتركه فارغًا للعمل محليًا بدون إنترنت.</p>
      <div class="form-group"><label>Supabase URL</label><input type="text" id="st-sb-url" value="${escapeHtml(settings.supabaseUrl || SAAS_SUPABASE_URL || '')}" placeholder="https://xxxx.supabase.co"></div>
      <div class="form-group"><label>Supabase Anon Key</label><input type="text" id="st-sb-key" value="${escapeHtml(settings.supabaseAnonKey || SAAS_SUPABASE_ANON_KEY || '')}" placeholder="anon key العلني فقط"></div>
      <button class="btn btn-primary btn-block" id="st-sb-test">اختبار الاتصال والتفعيل</button>
      <div style="font-size:13px;margin-top:10px;">
        حالة المزامنة: <b>${settings.backendMode === 'supabase' ? (navigator.onLine ? 'متصل' : 'غير متصل - وضع محلي') : 'محلي فقط'}</b>
        ${pendingSync ? ` - عمليات معلقة: <b style="color:var(--danger);">${pendingSync}</b>` : ''}
      </div>
      ${stuckError ? `
      <p style="font-size:12px;color:var(--danger);margin-top:8px;">تعذّر رفع بعض العمليات: ${escapeHtml(stuckError)}</p>
      <p style="font-size:10.5px;color:var(--text-muted);margin-top:4px;word-break:break-all;">تشخيص: shop_id بالعملية = ${escapeHtml(String(stuckItem.payload?.shop_id))} | shop_id الحالي = ${escapeHtml(String(settings.currentShopId))} | الجدول = ${escapeHtml(stuckItem.storeName)} | المحاولات = ${stuckItem.attempts}</p>
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

  container.querySelectorAll('[data-remove-user]').forEach(btn => btn.onclick = async () => {
    const ok = await confirmDialog({ title: 'حذف المستخدم', message: 'هل تريد حذف هذا الحساب؟' });
    if (!ok) return;
    await removeUser(btn.dataset.removeUser);
    toastSuccess('تم حذف الحساب');
    renderSettings(container);
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

export function applyTheme(theme) {
  document.body.classList.remove('theme-auto', 'theme-dark', 'theme-light');
  document.body.classList.add(`theme-${theme}`);
}

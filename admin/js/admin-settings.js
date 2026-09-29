// إعدادات لوحة المدير العام: فترة السماح، تنبيه التجديد، رسالة التواصل، سجل التدقيق
import * as adb from './admin-db.js';
import { getCurrentAdmin, adminSignOut } from './admin-auth.js';
import { formatDateTime, escapeHtml } from './admin-utils.js';
import { toastError, toastSuccess, setLoading, confirmDialog, emptyState } from '../../js/ui.js';
import { wireInstallButton, showIOSInstallInstructions } from '../../js/pwa-install.js';

export async function renderAdminSettings(container) {
  container.innerHTML = `<div class="skeleton" style="height:300px;"></div>`;
  const [settings, admin, auditLog, backupStatus] = await Promise.all([
    adb.getAdminSettings(), getCurrentAdmin(), adb.getAuditLog(30),
    adb.getBackupStatus().catch(() => null)
  ]);

  container.innerHTML = `
    <div class="card">
      <div class="section-title" style="margin-top:0;">حسابك</div>
      <div class="list-item">
        <div class="avatar">👑</div>
        <div class="info"><div class="title">${escapeHtml(admin ? admin.name : '')}</div><div class="subtitle">مدير عام</div></div>
      </div>
      <button class="btn btn-secondary btn-block" id="st-logout" style="margin-top:10px;">تسجيل الخروج</button>
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0;">تثبيت التطبيق</div>
      <button class="btn btn-outline btn-block" id="pwa-install-btn" style="display:none;">📲 تثبيت اللوحة على الجهاز</button>
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0;">النسخ الاحتياطي التلقائي</div>
      <div id="backup-status-box">${backupStatusHtml(backupStatus)}</div>
      <button class="btn btn-outline btn-block" id="st-run-backup" style="margin-top:10px;">تشغيل نسخة احتياطية الآن (اختبار)</button>
    </div>

    <div class="card">
      <div class="section-title" style="margin-top:0;">إعدادات التعليق التلقائي</div>
      <div class="form-group">
        <label>فترة السماح بعد انتهاء الاشتراك (أيام)</label>
        <input type="number" id="st-grace" min="0" value="${settings ? settings.grace_period_days : 7}">
        <p class="hint">بعد انتهاء هذه المدة دون تجديد، يُعلَّق حساب المحل تلقائيًا.</p>
      </div>
      <div class="form-group">
        <label>تنبيه اقتراب التجديد (أيام قبل الانتهاء)</label>
        <input type="number" id="st-reminder" min="0" value="${settings ? settings.reminder_days_before : 7}">
      </div>
      <div class="form-group">
        <label>رسالة التعليق (تظهر لصاحب المحل عند تعليق حسابه)</label>
        <textarea id="st-contact-msg">${escapeHtml(settings ? settings.contact_message || '' : '')}</textarea>
      </div>
      <button class="btn btn-primary btn-block" id="st-save">حفظ الإعدادات</button>
    </div>

    <div class="section-title">سجل العمليات الإدارية الأخيرة</div>
    <div class="card" style="padding:6px 10px;">
      ${auditLog.length ? auditLog.map(auditRow).join('') : emptyState('📋', 'لا توجد عمليات مسجّلة بعد')}
    </div>
  `;

  container.querySelector('#st-logout').onclick = async () => {
    const ok = await confirmDialog({ title: 'تسجيل الخروج', message: 'هل تريد تسجيل الخروج؟', danger: false, confirmLabel: 'خروج' });
    if (!ok) return;
    await adminSignOut();
    window.location.reload();
  };

  wireInstallButton(container.querySelector('#pwa-install-btn'), { onIOSInstructions: showIOSInstallInstructions });

  container.querySelector('#st-run-backup').onclick = async () => {
    const btn = container.querySelector('#st-run-backup');
    setLoading(btn, true, 'جاري تنفيذ النسخة الاحتياطية...');
    try {
      const result = await adb.runBackupNow();
      container.querySelector('#backup-status-box').innerHTML = backupStatusHtml(result);
      if (result.ok) toastSuccess('تمت النسخة الاحتياطية بنجاح');
      else toastError('انتهت النسخة الاحتياطية مع بعض الأخطاء، راجع التفاصيل بالأسفل');
    } catch (err) {
      toastError(err.message || 'فشل تشغيل النسخة الاحتياطية');
    }
    setLoading(btn, false);
  };

  container.querySelector('#st-save').onclick = async () => {
    const btn = container.querySelector('#st-save');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      await adb.updateAdminSettings({
        grace_period_days: parseInt(container.querySelector('#st-grace').value) || 0,
        reminder_days_before: parseInt(container.querySelector('#st-reminder').value) || 0,
        contact_message: container.querySelector('#st-contact-msg').value.trim()
      });
      toastSuccess('تم حفظ الإعدادات');
    } catch (err) {
      toastError('حدث خطأ أثناء الحفظ. حاول مرة أخرى.');
    }
    setLoading(btn, false);
  };
}

function backupStatusHtml(status) {
  if (!status) return `<p class="hint">لا يوجد أي نسخة احتياطية بعد. تُنفَّذ تلقائيًا كل يوم الساعة 1 فجرًا (بتوقيت غرينتش)، أو اضغط الزر بالأسفل لتجربتها الآن.</p>`;
  const totalRows = Object.values(status.counts || {}).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
  const sizeKb = Math.round((status.size_bytes || 0) / 1024);
  const failedTables = Object.entries(status.counts || {}).filter(([, v]) => typeof v !== 'number');
  return `
    <p class="hint" style="color:${status.ok ? 'var(--success, #16a34a)' : 'var(--danger, #dc2626)'};">
      ${status.ok ? '✅ آخر نسخة احتياطية نجحت' : '⚠️ آخر نسخة احتياطية انتهت مع أخطاء'} - ${formatDateTime(status.generated_at)}
    </p>
    <p class="hint">عدد الصفوف الإجمالي: ${totalRows.toLocaleString('ar')} - الحجم: ${sizeKb.toLocaleString('ar')} كيلوبايت</p>
    ${failedTables.length ? `<p class="hint" style="color:var(--danger, #dc2626);">جداول فشلت: ${failedTables.map(([t]) => escapeHtml(t)).join('، ')}</p>` : ''}
  `;
}

const ACTION_LABELS = {
  create_shop: 'إنشاء محل', suspend: 'تعليق حساب', reactivate: 'إعادة تفعيل',
  update_subscription: 'تحديث اشتراك', record_payment: 'تسجيل دفعة', update_settings: 'تحديث الإعدادات',
  delete_shop: 'حذف محل نهائيًا'
};

function auditRow(entry) {
  return `
    <div class="list-item">
      <div class="avatar">🧾</div>
      <div class="info">
        <div class="title">${ACTION_LABELS[entry.action] || entry.action}</div>
        <div class="subtitle">${escapeHtml(entry.admin_name || '')} - ${formatDateTime(entry.created_at)}</div>
      </div>
    </div>`;
}

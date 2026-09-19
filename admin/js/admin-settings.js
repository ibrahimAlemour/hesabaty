// إعدادات لوحة المدير العام: فترة السماح، تنبيه التجديد، رسالة التواصل، سجل التدقيق
import * as adb from './admin-db.js';
import { getCurrentAdmin, adminSignOut } from './admin-auth.js';
import { formatDateTime, escapeHtml } from './admin-utils.js';
import { toastError, toastSuccess, setLoading, confirmDialog, emptyState } from '../../js/ui.js';

export async function renderAdminSettings(container) {
  container.innerHTML = `<div class="skeleton" style="height:300px;"></div>`;
  const [settings, admin, auditLog] = await Promise.all([adb.getAdminSettings(), getCurrentAdmin(), adb.getAuditLog(30)]);

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

const ACTION_LABELS = {
  create_shop: 'إنشاء محل', suspend: 'تعليق حساب', reactivate: 'إعادة تفعيل',
  update_subscription: 'تحديث اشتراك', record_payment: 'تسجيل دفعة', update_settings: 'تحديث الإعدادات'
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

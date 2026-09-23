// شاشة رسائل SMS: قوالب، جدولة الإرسال حسب تصنيف الزبون، وسجل النتائج
// الإرسال الفعلي يتم من الخادم (worker.js) وقت الموعد المحدد - هذه الشاشة تدير البيانات فقط
import * as db from './database.js';
import { getCurrentUser, canDelete } from './auth.js';
import { escapeHtml, formatDateTime } from './utils.js';
import { toastError, toastSuccess, setLoading, openSheet, closeSheet, confirmDialog, emptyState } from './ui.js';

const TARGET_LABELS = { all: 'كل الزبائن', weekly: 'الزبائن الأسبوعيين', monthly: 'الزبائن الشهريين' };
const RECURRING_LABELS = { once: 'مرة واحدة', weekly: 'متكرر أسبوعيًا', monthly: 'متكرر شهريًا' };
const STATUS_LABELS = { pending: 'بانتظار الإرسال', completed: 'تم الإرسال', cancelled: 'أُلغيت', failed: 'فشلت', sent: 'تم الإرسال' };

export async function renderSms(container) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const [templates, schedules, log, settings, user] = await Promise.all([
    db.getSmsTemplates(), db.getSmsSchedules(), db.getSmsLog(50), db.getSettings(), getCurrentUser()
  ]);
  const canManage = canDelete(user);

  container.innerHTML = `
    ${settings.backendMode !== 'supabase' ? `
    <div class="card" style="background:var(--warning-light);">
      <p style="font-size:12.5px;color:var(--warning);margin:0;">⚠️ الجدولة التلقائية تحتاج اتصال سوبابيس (وضع SaaS) حتى يعمل خادم الإرسال بالخلفية. بالوضع المحلي تقدر تجهّز القوالب والجدولات بس ما رح تُرسل تلقائيًا.</p>
    </div>` : ''}

    <div class="section-title" style="margin-top:0;">القوالب <span class="link" id="add-template-btn">+ إضافة قالب</span></div>
    <div class="card" style="padding:6px 10px;">
      ${templates.length ? templates.map(templateRow).join('') : emptyState('✉️', 'لا توجد قوالب بعد', 'أضف قالبًا لتبدأ الجدولة')}
    </div>

    <div class="section-title">الجدولة ${canManage ? `<span class="link" id="add-schedule-btn">+ جدولة جديدة</span>` : ''}</div>
    <div class="card" style="padding:6px 10px;">
      ${schedules.length ? schedules.map(s => scheduleRow(s, templates)).join('') : emptyState('🗓️', 'لا توجد جدولات بعد')}
    </div>

    <div class="section-title">سجل الإرسال</div>
    <div class="card" style="padding:6px 10px;">
      ${log.length ? log.map(logRow).join('') : emptyState('📋', 'لا توجد رسائل مُرسلة بعد')}
    </div>
  `;

  container.querySelector('#add-template-btn').onclick = () => openTemplateForm(container, null);
  container.querySelectorAll('[data-tpl-edit]').forEach(el => el.onclick = () => {
    const t = templates.find(x => x.id === el.dataset.tplEdit);
    openTemplateForm(container, t);
  });
  container.querySelectorAll('[data-tpl-delete]').forEach(el => el.onclick = async () => {
    const t = templates.find(x => x.id === el.dataset.tplDelete);
    const ok = await confirmDialog({ title: 'حذف قالب', message: `هل تريد حذف قالب "${t.name}"؟` });
    if (!ok) return;
    try { await db.deleteSmsTemplate(t.id); toastSuccess('تم حذف القالب'); renderSms(container); }
    catch (err) { toastError(err.message || 'حدث خطأ أثناء الحذف'); }
  });

  const addScheduleBtn = container.querySelector('#add-schedule-btn');
  if (addScheduleBtn) addScheduleBtn.onclick = () => {
    if (!templates.length) return toastError('أضف قالبًا أولًا قبل الجدولة');
    openScheduleForm(container, templates);
  };
  container.querySelectorAll('[data-sch-cancel]').forEach(el => el.onclick = async () => {
    const ok = await confirmDialog({ title: 'إلغاء الجدولة', message: 'هل تريد إلغاء هذه الجدولة؟', danger: false, confirmLabel: 'إلغاء الجدولة' });
    if (!ok) return;
    await db.cancelSmsSchedule(el.dataset.schCancel);
    toastSuccess('تم إلغاء الجدولة');
    renderSms(container);
  });
  container.querySelectorAll('[data-sch-delete]').forEach(el => el.onclick = async () => {
    const ok = await confirmDialog({ title: 'حذف الجدولة', message: 'هل تريد حذف هذه الجدولة نهائيًا؟' });
    if (!ok) return;
    await db.deleteSmsSchedule(el.dataset.schDelete);
    toastSuccess('تم حذف الجدولة');
    renderSms(container);
  });
}

function templateRow(t) {
  return `
    <div class="list-item">
      <div class="avatar">✉️</div>
      <div class="info"><div class="title">${escapeHtml(t.name)}</div><div class="subtitle">${escapeHtml(t.body.slice(0, 40))}${t.body.length > 40 ? '...' : ''}</div></div>
      <button class="icon-btn" data-tpl-edit="${t.id}" title="تعديل"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
      <button class="remove-btn" data-tpl-delete="${t.id}" title="حذف"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>
    </div>`;
}

function scheduleRow(s, templates) {
  const tpl = templates.find(t => t.id === s.template_id);
  const statusColor = { pending: 'var(--blue)', completed: 'var(--success)', cancelled: 'var(--text-muted)' }[s.status] || 'var(--text-muted)';
  return `
    <div class="list-item">
      <div class="avatar">🗓️</div>
      <div class="info">
        <div class="title">${escapeHtml(s.name || tpl?.name || 'جدولة')} <span class="badge" style="background:var(--blue-light);color:var(--blue);">${TARGET_LABELS[s.target] || s.target}</span></div>
        <div class="subtitle">${formatDateTime(s.scheduled_at)} - ${RECURRING_LABELS[s.recurring] || s.recurring}</div>
      </div>
      <div style="text-align:left;">
        <div class="meta" style="color:${statusColor};font-weight:700;">${STATUS_LABELS[s.status] || s.status}</div>
        ${s.status === 'pending' ? `<button class="btn btn-sm btn-secondary" data-sch-cancel="${s.id}" style="margin-top:4px;">إلغاء</button>` : `<button class="btn btn-sm btn-danger" data-sch-delete="${s.id}" style="margin-top:4px;">حذف</button>`}
      </div>
    </div>`;
}

function logRow(entry) {
  const color = { sent: 'var(--success)', failed: 'var(--danger)', pending: 'var(--warning)' }[entry.status] || 'var(--text-muted)';
  return `
    <div class="list-item">
      <div class="avatar">📩</div>
      <div class="info">
        <div class="title">${escapeHtml(entry.customer_name || 'زبون')}</div>
        <div class="subtitle">${escapeHtml((entry.message || '').slice(0, 50))}${(entry.message || '').length > 50 ? '...' : ''}</div>
        ${entry.error ? `<div class="meta" style="color:var(--danger);">${escapeHtml(entry.error)}</div>` : ''}
      </div>
      <div style="text-align:left;">
        <div class="meta" style="color:${color};font-weight:700;">${STATUS_LABELS[entry.status] || entry.status}</div>
        <div class="meta">${formatDateTime(entry.sent_at || entry.created_at)}</div>
      </div>
    </div>`;
}

function openTemplateForm(container, template) {
  const isEdit = !!template;
  const overlay = openSheet(`
    <div class="sheet-header"><h3>${isEdit ? 'تعديل قالب' : '+ إضافة قالب'}</h3></div>
    <div class="form-group"><label>اسم القالب</label><input type="text" id="tpl-name" value="${isEdit ? escapeHtml(template.name) : ''}" placeholder="مثال: تذكير أسبوعي"></div>
    <div class="form-group">
      <label>نص الرسالة</label>
      <textarea id="tpl-body" placeholder="مرحبًا {name}، رصيدك المستحق {amount} وموعد السداد {due_date}. - {shop_name}">${isEdit ? escapeHtml(template.body) : ''}</textarea>
      <p class="hint">استخدم: {name} الاسم، {amount} المبلغ المستحق، {due_date} موعد السداد، {shop_name} اسم المحل</p>
    </div>
    <button class="btn btn-primary btn-block" id="tpl-save">${isEdit ? 'حفظ التعديلات' : 'إضافة القالب'}</button>
  `, { onOpen: (el) => el.querySelector('#tpl-name').focus() });

  overlay.querySelector('#tpl-save').onclick = async () => {
    const btn = overlay.querySelector('#tpl-save');
    const name = overlay.querySelector('#tpl-name').value.trim();
    const body = overlay.querySelector('#tpl-body').value.trim();
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      if (isEdit) await db.updateSmsTemplate(template.id, { name, body }); else await db.addSmsTemplate({ name, body });
      closeSheet();
      toastSuccess(isEdit ? 'تم تحديث القالب' : 'تم إضافة القالب');
      renderSms(container);
    } catch (err) {
      toastError(err.message || 'حدث خطأ أثناء الحفظ');
      setLoading(btn, false);
    }
  };
}

function openScheduleForm(container, templates) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>+ جدولة جديدة</h3></div>
    <div class="form-group"><label>اسم الجدولة (اختياري)</label><input type="text" id="sch-name" placeholder="مثال: تذكير نهاية الأسبوع"></div>
    <div class="form-group"><label>القالب</label>
      <select id="sch-template">${templates.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label>الفئة المستهدفة</label>
      <select id="sch-target">
        <option value="all">كل الزبائن</option>
        <option value="weekly">الزبائن الأسبوعيين فقط</option>
        <option value="monthly">الزبائن الشهريين فقط</option>
      </select>
    </div>
    <div class="form-group"><label>تاريخ ووقت الإرسال</label><input type="datetime-local" id="sch-datetime"></div>
    <div class="form-group"><label>التكرار</label>
      <select id="sch-recurring">
        <option value="once">مرة واحدة فقط</option>
        <option value="weekly">تكرار أسبوعي</option>
        <option value="monthly">تكرار شهري</option>
      </select>
    </div>
    <button class="btn btn-primary btn-block" id="sch-save">حفظ الجدولة</button>
  `);

  overlay.querySelector('#sch-save').onclick = async () => {
    const btn = overlay.querySelector('#sch-save');
    const dtValue = overlay.querySelector('#sch-datetime').value;
    if (!dtValue) return toastError('حدد تاريخ ووقت الإرسال');
    const scheduledAt = new Date(dtValue).toISOString();
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      await db.addSmsSchedule({
        name: overlay.querySelector('#sch-name').value.trim(),
        templateId: overlay.querySelector('#sch-template').value,
        target: overlay.querySelector('#sch-target').value,
        scheduledAt,
        recurring: overlay.querySelector('#sch-recurring').value
      });
      closeSheet();
      toastSuccess('تم حفظ الجدولة');
      renderSms(container);
    } catch (err) {
      toastError(err.message || 'حدث خطأ أثناء الحفظ');
      setLoading(btn, false);
    }
  };
}

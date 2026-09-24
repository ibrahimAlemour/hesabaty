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
    db.getSmsTemplates(), db.getSmsSchedules(), db.getSmsLog(200), db.getSettings(), getCurrentUser()
  ]);
  const canManage = canDelete(user);

  const activeSchedules = schedules.filter(s => s.status === 'pending');
  const archivedSchedules = schedules.filter(s => s.status !== 'pending');
  const sentCount = log.filter(e => e.status === 'sent').length;
  const failedCount = log.filter(e => e.status === 'failed').length;

  container.innerHTML = `
    ${settings.backendMode !== 'supabase' ? `
    <div class="card" style="background:var(--warning-light);">
      <p style="font-size:12.5px;color:var(--warning);margin:0;">⚠️ الجدولة التلقائية تحتاج اتصال سوبابيس (وضع SaaS) حتى يعمل خادم الإرسال بالخلفية. بالوضع المحلي تقدر تجهّز القوالب والجدولات بس ما رح تُرسل تلقائيًا.</p>
    </div>` : ''}

    <div class="section-title" style="margin-top:0;">القوالب ${canManage ? `<span class="link" id="add-template-btn">+ إضافة قالب</span>` : ''}</div>
    <div class="card" style="padding:6px 10px;">
      ${templates.length ? templates.map(t => templateRow(t, canManage)).join('') : emptyState('✉️', 'لا توجد قوالب بعد', 'أضف قالبًا لتبدأ الجدولة')}
    </div>

    <div class="section-title">الجدولة ${canManage ? `<span class="link" id="add-schedule-btn">+ جدولة جديدة</span>` : ''}</div>
    <div class="card" style="padding:6px 10px;">
      ${activeSchedules.length ? activeSchedules.map(s => scheduleRow(s, templates, false, canManage)).join('') : emptyState('🗓️', 'لا توجد جدولات قائمة بانتظار الإرسال')}
    </div>

    ${archivedSchedules.length ? `
    <details class="card" style="padding:6px 10px;">
      <summary style="cursor:pointer;font-weight:700;font-size:13.5px;padding:6px 4px;">📦 الأرشيف (${archivedSchedules.length})</summary>
      ${archivedSchedules.map(s => scheduleRow(s, templates, true, canManage)).join('')}
    </details>` : ''}

    <div class="section-title">
      سجل الإرسال
      ${log.length ? `<span class="meta" style="font-weight:700;">✅ ${sentCount} تم${failedCount ? ` &nbsp;|&nbsp; ❌ ${failedCount} فشل` : ''}</span>` : ''}
    </div>
    ${log.length ? `
    <div class="card" style="padding:8px 10px;display:flex;gap:8px;flex-wrap:wrap;">
      <input type="text" id="log-search" placeholder="بحث باسم الزبون..." style="flex:1;min-width:140px;">
      <select id="log-status-filter" style="min-width:110px;">
        <option value="">كل الحالات</option>
        <option value="sent">تم الإرسال</option>
        <option value="failed">فشلت</option>
      </select>
    </div>` : ''}
    <div class="card" style="padding:6px 10px;" id="log-list">
      ${log.length ? log.map(logRow).join('') : emptyState('📋', 'لا توجد رسائل مُرسلة بعد')}
    </div>
  `;

  const addTemplateBtn = container.querySelector('#add-template-btn');
  if (addTemplateBtn) addTemplateBtn.onclick = () => openTemplateForm(container, null);
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
    openScheduleForm(container, templates, null);
  };
  container.querySelectorAll('[data-sch-edit]').forEach(el => el.onclick = () => {
    const s = schedules.find(x => x.id === el.dataset.schEdit);
    openScheduleForm(container, templates, s);
  });
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
  container.querySelectorAll('[data-sch-view-log]').forEach(el => el.onclick = () => {
    const s = schedules.find(x => x.id === el.dataset.schViewLog);
    openScheduleLogSheet(s, log);
  });

  const logListEl = container.querySelector('#log-list');
  const searchInput = container.querySelector('#log-search');
  const statusFilter = container.querySelector('#log-status-filter');
  const applyLogFilter = () => {
    const q = (searchInput?.value || '').trim().toLowerCase();
    const status = statusFilter?.value || '';
    const filtered = log.filter(e =>
      (!q || (e.customer_name || '').toLowerCase().includes(q)) &&
      (!status || e.status === status)
    );
    logListEl.innerHTML = filtered.length ? filtered.map(logRow).join('') : emptyState('🔍', 'لا توجد نتائج مطابقة');
  };
  if (searchInput) searchInput.oninput = applyLogFilter;
  if (statusFilter) statusFilter.onchange = applyLogFilter;
}

function templateRow(t, canManage) {
  return `
    <div class="list-item">
      <div class="avatar">✉️</div>
      <div class="info"><div class="title">${escapeHtml(t.name)}</div><div class="subtitle">${escapeHtml(t.body.slice(0, 40))}${t.body.length > 40 ? '...' : ''}</div></div>
      ${canManage ? `
      <button class="icon-btn" data-tpl-edit="${t.id}" title="تعديل"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
      <button class="remove-btn" data-tpl-delete="${t.id}" title="حذف"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>
      ` : ''}
    </div>`;
}

function scheduleRow(s, templates, archived, canManage) {
  const tpl = templates.find(t => t.id === s.template_id);
  const statusColor = { pending: 'var(--blue)', completed: 'var(--success)', cancelled: 'var(--text-muted)' }[s.status] || 'var(--text-muted)';
  return `
    <div class="list-item">
      <div class="avatar" style="cursor:pointer;" data-sch-view-log="${s.id}">🗓️</div>
      <div class="info" style="cursor:pointer;" data-sch-view-log="${s.id}">
        <div class="title">${escapeHtml(s.name || tpl?.name || 'جدولة')} <span class="badge" style="background:var(--blue-light);color:var(--blue);">${TARGET_LABELS[s.target] || s.target}</span></div>
        <div class="subtitle">${formatDateTime(s.scheduled_at)} - ${RECURRING_LABELS[s.recurring] || s.recurring}</div>
      </div>
      <div style="text-align:left;">
        <div class="meta" style="color:${statusColor};font-weight:700;">${STATUS_LABELS[s.status] || s.status}</div>
        ${canManage ? `
        <div style="display:flex;gap:4px;margin-top:4px;justify-content:flex-end;">
          ${!archived ? `
            <button class="icon-btn" data-sch-edit="${s.id}" title="تعديل"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
            <button class="btn btn-sm btn-secondary" data-sch-cancel="${s.id}">إلغاء</button>
          ` : `<button class="remove-btn" data-sch-delete="${s.id}" title="حذف"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>`}
        </div>
        ` : ''}
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

function openScheduleLogSheet(schedule, log) {
  const filtered = log.filter(e => e.schedule_id === schedule.id);
  const sentCount = filtered.filter(e => e.status === 'sent').length;
  const failedCount = filtered.filter(e => e.status === 'failed').length;
  openSheet(`
    <div class="sheet-header"><h3>سجل: ${escapeHtml(schedule.name || 'جدولة')}</h3></div>
    <p class="hint" style="padding:0 4px;">✅ ${sentCount} تم${failedCount ? ` &nbsp;|&nbsp; ❌ ${failedCount} فشل` : ''}</p>
    <div class="card" style="padding:6px 10px;">
      ${filtered.length ? filtered.map(logRow).join('') : emptyState('📋', 'لا توجد رسائل مسجّلة لهذه الجدولة بعد')}
    </div>
  `);
}

// يحسب عدد الحروف وعدد رسائل SMS التقريبي (الطول الفعلي يختلف حسب قيم {name}/{amount}/{due_date} الحقيقية لكل زبون)
function smsSegmentInfo(text) {
  const len = text.length;
  if (!len) return { len: 0, segments: 0 };
  const segments = len <= 70 ? 1 : Math.ceil(len / 67);
  return { len, segments };
}

function updateCharCounter(el, text) {
  const { len, segments } = smsSegmentInfo(text);
  el.textContent = segments <= 1
    ? `${len} حرف تقريبًا - رسالة واحدة`
    : `${len} حرف تقريبًا - ${segments} رسائل (السعر يتضاعف حسب عدد الرسائل)`;
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
      <p class="hint" id="tpl-char-counter" style="font-weight:700;"></p>
    </div>
    <button class="btn btn-primary btn-block" id="tpl-save">${isEdit ? 'حفظ التعديلات' : 'إضافة القالب'}</button>
  `, { onOpen: (el) => el.querySelector('#tpl-name').focus() });

  const bodyEl = overlay.querySelector('#tpl-body');
  const counterEl = overlay.querySelector('#tpl-char-counter');
  updateCharCounter(counterEl, bodyEl.value);
  bodyEl.oninput = () => updateCharCounter(counterEl, bodyEl.value);

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

// يحوّل تاريخ ISO لصيغة datetime-local (YYYY-MM-DDTHH:mm) بالتوقيت المحلي
function toDatetimeLocalValue(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openScheduleForm(container, templates, schedule) {
  const isEdit = !!schedule;
  const overlay = openSheet(`
    <div class="sheet-header"><h3>${isEdit ? 'تعديل الجدولة' : '+ جدولة جديدة'}</h3></div>
    <div class="form-group"><label>اسم الجدولة (اختياري)</label><input type="text" id="sch-name" placeholder="مثال: تذكير نهاية الأسبوع" value="${isEdit ? escapeHtml(schedule.name || '') : ''}"></div>
    <div class="form-group"><label>القالب</label>
      <select id="sch-template">${templates.map(t => `<option value="${t.id}" ${isEdit && schedule.template_id === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label>الفئة المستهدفة</label>
      <select id="sch-target">
        <option value="all" ${isEdit && schedule.target === 'all' ? 'selected' : ''}>كل الزبائن</option>
        <option value="weekly" ${isEdit && schedule.target === 'weekly' ? 'selected' : ''}>الزبائن الأسبوعيين فقط</option>
        <option value="monthly" ${isEdit && schedule.target === 'monthly' ? 'selected' : ''}>الزبائن الشهريين فقط</option>
      </select>
    </div>
    <div class="form-group">
      <label>الزبائن المستهدفون (فُك التحديد لاستثناء زبون من هذه الجدولة فقط)</label>
      <div id="sch-customers-list" style="max-height:220px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;padding:4px;"></div>
    </div>
    <div class="form-group"><label>تاريخ ووقت الإرسال</label><input type="datetime-local" id="sch-datetime" value="${isEdit ? toDatetimeLocalValue(schedule.scheduled_at) : ''}"></div>
    <div class="form-group"><label>التكرار</label>
      <select id="sch-recurring">
        <option value="once" ${isEdit && schedule.recurring === 'once' ? 'selected' : ''}>مرة واحدة فقط</option>
        <option value="weekly" ${isEdit && schedule.recurring === 'weekly' ? 'selected' : ''}>تكرار أسبوعي</option>
        <option value="monthly" ${isEdit && schedule.recurring === 'monthly' ? 'selected' : ''}>تكرار شهري</option>
      </select>
    </div>
    <button class="btn btn-primary btn-block" id="sch-save">${isEdit ? 'حفظ التعديلات' : 'حفظ الجدولة'}</button>
  `);

  const listEl = overlay.querySelector('#sch-customers-list');
  let firstRender = true;
  const renderCustomerList = async (target) => {
    listEl.innerHTML = `<p class="hint" style="padding:8px;">جاري التحميل...</p>`;
    const customers = await db.getSmsTargetCustomers(target);
    const preExcluded = new Set(firstRender && isEdit ? (schedule.excluded_customer_ids || []) : []);
    firstRender = false;
    listEl.innerHTML = customers.length ? customers.map(c => `
      <label style="display:flex;align-items:center;gap:8px;padding:6px 4px;border-bottom:1px solid var(--border);">
        <input type="checkbox" class="sch-cust-check" value="${c.id}" ${preExcluded.has(c.id) ? '' : 'checked'}>
        <span style="flex:1;">${escapeHtml(c.name)}</span>
        <span class="meta">${db.formatMoneyPlain(c.balance)}</span>
      </label>`).join('') : `<p class="hint" style="padding:8px;">لا يوجد زبائن بهذه الفئة عليهم دين حاليًا</p>`;
  };

  overlay.querySelector('#sch-target').onchange = (e) => renderCustomerList(e.target.value);
  renderCustomerList(isEdit ? schedule.target : 'all');

  overlay.querySelector('#sch-save').onclick = async () => {
    const btn = overlay.querySelector('#sch-save');
    const dtValue = overlay.querySelector('#sch-datetime').value;
    if (!dtValue) return toastError('حدد تاريخ ووقت الإرسال');
    const scheduledAt = new Date(dtValue).toISOString();
    const excludedCustomerIds = Array.from(overlay.querySelectorAll('.sch-cust-check'))
      .filter(cb => !cb.checked).map(cb => cb.value);
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      const payload = {
        name: overlay.querySelector('#sch-name').value.trim(),
        templateId: overlay.querySelector('#sch-template').value,
        target: overlay.querySelector('#sch-target').value,
        scheduledAt,
        recurring: overlay.querySelector('#sch-recurring').value,
        excludedCustomerIds
      };
      if (isEdit) await db.updateSmsSchedule(schedule.id, payload); else await db.addSmsSchedule(payload);
      closeSheet();
      toastSuccess(isEdit ? 'تم حفظ التعديلات' : 'تم حفظ الجدولة');
      renderSms(container);
    } catch (err) {
      toastError(err.message || 'حدث خطأ أثناء الحفظ');
      setLoading(btn, false);
    }
  };
}

// شاشة رسائل SMS: تدفق إرسال مبسّط (قالب → مستلمون → موعد → ملخص → إرسال)، بالإضافة لإدارة القوالب
// والجدولات القائمة وسجل النتائج. الإرسال الفعلي يتم من الخادم (worker.js) وقت الموعد المحدد -
// هذه الشاشة تدير البيانات فقط (لا تغيير إطلاقًا بمنطق الإرسال أو حساب الرسائل أو البيانات المخزّنة).
import * as db from './database.js';
import { getCurrentUser, canDelete } from './auth.js';
import { escapeHtml, formatDateTime, fuzzyMatch, debounce } from './utils.js';
import { toastError, toastSuccess, setLoading, openSheet, closeSheet, confirmDialog, emptyState } from './ui.js';

const TARGET_LABELS = { all: 'كل الزبائن', weekly: 'الزبائن الأسبوعيين', monthly: 'الزبائن الشهريين' };
const RECURRING_LABELS = { once: 'مرة واحدة', weekly: 'متكرر أسبوعيًا', monthly: 'متكرر شهريًا' };
const STATUS_LABELS = { pending: 'بانتظار الإرسال', completed: 'تم الإرسال', cancelled: 'أُلغيت', failed: 'فشلت', sent: 'تم الإرسال' };

// ---------- حالة قسم "إرسال رسالة جديدة" (تُصفَّر كل دخول للشاشة) ----------
let composeState;
function freshComposeState() {
  return {
    editingScheduleId: null,
    templateId: null,
    recipientMode: 'all', // all | weekly | monthly | manual
    excludedIds: new Set(),      // استثناءات "خيارات إضافية" لأوضاع all/weekly/monthly
    manualSelectedIds: new Set(),// التحديد اليدوي الصريح لوضع "تحديد يدوي"
    manualQuery: '',
    timing: 'now', // now | later
    laterDate: '',
    laterTime: '',
    recurring: 'once',
    name: ''
  };
}

export async function renderSms(container) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  composeState = freshComposeState();
  const [templates, schedules, log, settings, user, totalSent] = await Promise.all([
    db.getSmsTemplates(), db.getSmsSchedules(), db.getSmsLog(200), db.getSettings(), getCurrentUser(), db.getSmsTotalSent()
  ]);
  const canManage = canDelete(user);
  const allCustomers = await db.getSmsTargetCustomers('all');
  renderSmsScreen(container, { templates, schedules, log, settings, canManage, totalSent, allCustomers });
}

function renderSmsScreen(container, data) {
  const { templates, schedules, log, settings, canManage, totalSent, allCustomers } = data;
  const activeSchedules = schedules.filter(s => s.status === 'pending');
  const archivedSchedules = schedules.filter(s => s.status !== 'pending');
  const sentCount = log.filter(e => e.status === 'sent').length;
  const failedCount = log.filter(e => e.status === 'failed').length;

  container.innerHTML = `
    ${settings.backendMode !== 'supabase' ? `
    <div class="card" style="background:var(--warning-light);">
      <p style="font-size:12.5px;color:var(--warning);margin:0;">⚠️ الإرسال التلقائي يحتاج اتصال سوبابيس (وضع SaaS) حتى يعمل خادم الإرسال بالخلفية. بالوضع المحلي تقدر تجهّز القوالب والجدولات بس ما رح تُرسل تلقائيًا.</p>
    </div>` : `
    <div class="stat-grid">
      <div class="stat-card profit wide"><div class="stat-label">✉️ إجمالي الرسائل المرسلة</div><div class="stat-value">${totalSent === null ? '—' : `${totalSent} رسالة`}</div></div>
    </div>`}

    ${canManage ? `<div class="card" id="sms-compose-card"></div>` : ''}

    <div class="section-title">الجدولات القائمة</div>
    <div class="card" style="padding:6px 10px;" id="sms-active-schedules">
      ${activeSchedules.length ? activeSchedules.map(s => scheduleRow(s, templates, false, canManage)).join('') : emptyState('🗓️', 'لا توجد جدولات قائمة بانتظار الإرسال')}
    </div>

    ${archivedSchedules.length ? `
    <details class="card" style="padding:6px 10px;">
      <summary style="cursor:pointer;font-weight:700;font-size:13.5px;padding:6px 4px;">📦 الأرشيف (${archivedSchedules.length})</summary>
      <div id="sms-archived-schedules">${archivedSchedules.map(s => scheduleRow(s, templates, true, canManage)).join('')}</div>
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

  if (canManage) renderComposeCard(container, data);
  bindScheduleEvents(container, data);
  bindLogFilter(container, log);
}

// ============================================================
// قسم "إرسال رسالة جديدة" - القلب الجديد للشاشة
// ============================================================

function renderComposeCard(container, data) {
  const card = container.querySelector('#sms-compose-card');
  const { templates } = data;
  const s = composeState;

  card.innerHTML = `
    <div class="section-title" style="margin-top:0;">${s.editingScheduleId ? '✏️ تعديل الجدولة' : '✈️ إرسال رسالة جديدة'}</div>

    ${templates.length ? `
    <div class="form-group">
      <label>قالب الرسالة</label>
      <div style="display:flex;gap:8px;align-items:center;">
        <select id="cmp-template" style="flex:1;">
          <option value="">اختر قالبًا...</option>
          ${templates.map(t => `<option value="${t.id}" ${s.templateId === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
        </select>
        <button type="button" class="icon-btn" id="cmp-tpl-manage" title="إدارة القوالب">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        </button>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <button type="button" class="btn btn-secondary btn-sm" id="cmp-tpl-add">+ إضافة قالب</button>
      <button type="button" class="btn btn-secondary btn-sm" id="cmp-tpl-edit" ${s.templateId ? '' : 'disabled'}>✏️ تعديل القالب</button>
    </div>
    <div id="cmp-tpl-preview"></div>

    <div class="section-title">تحديد المستلمين</div>
    <div class="pay-methods" style="grid-template-columns:repeat(4,1fr);">
      <div class="pay-method-btn ${s.recipientMode === 'all' ? 'active' : ''}" data-mode="all"><span class="emoji">👥</span>جميع الزبائن</div>
      <div class="pay-method-btn ${s.recipientMode === 'weekly' ? 'active' : ''}" data-mode="weekly"><span class="emoji">🗓️</span>أسبوعيون</div>
      <div class="pay-method-btn ${s.recipientMode === 'monthly' ? 'active' : ''}" data-mode="monthly"><span class="emoji">🗓️</span>شهريون</div>
      <div class="pay-method-btn ${s.recipientMode === 'manual' ? 'active' : ''}" data-mode="manual"><span class="emoji">👤</span>تحديد يدوي</div>
    </div>
    ${s.recipientMode !== 'manual' ? `<button type="button" class="btn btn-outline btn-sm" id="cmp-extra-options" style="margin-bottom:12px;">⚙️ خيارات إضافية (استثناء زبائن)</button>` : ''}
    <div id="cmp-manual-wrap" style="${s.recipientMode === 'manual' ? '' : 'display:none;'}"></div>

    <div class="section-title">موعد الإرسال</div>
    <div class="seg-tabs" style="margin-bottom:10px;">
      <button type="button" class="seg-tab ${s.timing === 'now' ? 'active' : ''}" data-timing="now">إرسال الآن</button>
      <button type="button" class="seg-tab ${s.timing === 'later' ? 'active' : ''}" data-timing="later">جدولة لاحقًا</button>
    </div>
    <div id="cmp-later-fields" style="display:${s.timing === 'later' ? 'flex' : 'none'};gap:8px;margin-bottom:10px;">
      <div class="form-group" style="flex:1;margin-bottom:0;"><label>التاريخ</label><input type="date" id="cmp-date" value="${s.laterDate}"></div>
      <div class="form-group" style="flex:1;margin-bottom:0;"><label>الوقت</label><input type="time" id="cmp-time" value="${s.laterTime}"></div>
    </div>
    <div class="form-group">
      <label>التكرار</label>
      <select id="cmp-recurring">
        <option value="once" ${s.recurring === 'once' ? 'selected' : ''}>مرة واحدة فقط</option>
        <option value="weekly" ${s.recurring === 'weekly' ? 'selected' : ''}>تكرار أسبوعي تلقائي</option>
        <option value="monthly" ${s.recurring === 'monthly' ? 'selected' : ''}>تكرار شهري تلقائي</option>
      </select>
      <p class="hint">لو اخترت تكرارًا، بترسل تلقائيًا بنفس الموعد كل أسبوع/شهر من تلقاء نفسها بدون أي تدخل منك</p>
    </div>
    <div class="form-group"><label>اسم الجدولة (اختياري، للتمييز بالسجل فقط)</label><input type="text" id="cmp-name" placeholder="مثال: تذكير نهاية الشهر" value="${escapeHtml(s.name)}"></div>

    <div class="totals-box" id="cmp-summary"></div>

    <button type="button" class="btn btn-primary btn-block" id="cmp-send-btn">✈️ ${s.editingScheduleId ? 'حفظ التعديلات' : 'إرسال الرسائل'}</button>
    ${s.editingScheduleId ? `<button type="button" class="btn btn-secondary btn-block" style="margin-top:8px;" id="cmp-cancel-edit">إلغاء التعديل</button>` : ''}
    ` : `
    <p class="hint" style="padding:8px 0;">أضف قالب رسالة أولًا لتقدر ترسل</p>
    <button type="button" class="btn btn-primary btn-block" id="cmp-tpl-add">+ إضافة قالب</button>
    `}
  `;

  if (!templates.length) {
    card.querySelector('#cmp-tpl-add').onclick = () => openTemplateForm(container, null, data);
    return;
  }

  renderTemplatePreview(card, templates);
  if (s.recipientMode === 'manual') renderManualSelect(card, data);
  updateSummary(card, data);

  card.querySelector('#cmp-template').onchange = (e) => {
    composeState.templateId = e.target.value || null;
    card.querySelector('#cmp-tpl-edit').disabled = !composeState.templateId;
    renderTemplatePreview(card, templates);
    updateSummary(card, data);
  };
  card.querySelector('#cmp-tpl-manage').onclick = () => openManageTemplatesSheet(container, data);
  card.querySelector('#cmp-tpl-add').onclick = () => openTemplateForm(container, null, data);
  card.querySelector('#cmp-tpl-edit').onclick = () => {
    const tpl = templates.find(t => t.id === composeState.templateId);
    if (tpl) openTemplateForm(container, tpl, data);
  };

  card.querySelectorAll('[data-mode]').forEach(btn => btn.onclick = () => {
    composeState.recipientMode = btn.dataset.mode;
    renderComposeCard(container, data);
  });
  const extraBtn = card.querySelector('#cmp-extra-options');
  if (extraBtn) extraBtn.onclick = () => openExcludeSheet(container, data);

  card.querySelectorAll('[data-timing]').forEach(btn => btn.onclick = () => {
    composeState.timing = btn.dataset.timing;
    card.querySelectorAll('[data-timing]').forEach(b => b.classList.toggle('active', b === btn));
    card.querySelector('#cmp-later-fields').style.display = composeState.timing === 'later' ? 'flex' : 'none';
    updateSummary(card, data);
  });
  card.querySelector('#cmp-date').oninput = (e) => { composeState.laterDate = e.target.value; updateSummary(card, data); };
  card.querySelector('#cmp-time').oninput = (e) => { composeState.laterTime = e.target.value; updateSummary(card, data); };
  card.querySelector('#cmp-recurring').onchange = (e) => { composeState.recurring = e.target.value; };
  card.querySelector('#cmp-name').oninput = (e) => { composeState.name = e.target.value; };

  card.querySelector('#cmp-send-btn').onclick = () => handleSend(container, data);
  const cancelEditBtn = card.querySelector('#cmp-cancel-edit');
  if (cancelEditBtn) cancelEditBtn.onclick = () => { composeState = freshComposeState(); renderComposeCard(container, data); };
}

function renderTemplatePreview(card, templates) {
  const previewEl = card.querySelector('#cmp-tpl-preview');
  const tpl = templates.find(t => t.id === composeState.templateId);
  if (!tpl) { previewEl.innerHTML = ''; return; }
  const sample = db.renderSmsTemplate(tpl.body, { customerName: 'أحمد', balanceCents: 15000, dueDate: new Date().toISOString(), shopName: 'محلك' });
  const segments = db.countSmsSegments(tpl.body);
  previewEl.innerHTML = `
    <div class="card" style="background:var(--bg);padding:12px;margin-bottom:4px;">
      <div style="display:flex;align-items:flex-start;gap:8px;">
        <span style="font-size:17px;">💬</span>
        <div style="font-size:13.5px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(sample)}</div>
      </div>
    </div>
    <p class="hint" style="font-weight:700;">${tpl.body.length} حرف تقريبًا - ${segments <= 1 ? 'رسالة واحدة' : `${segments} رسائل لكل مستلم`}</p>
  `;
}

// يحسب قائمة المستلمين الحالية حسب الوضع المختار (بدون أي تغيير بمنطق التصفية الفعلي بالخادم)
function currentRecipientIds(allCustomers) {
  const s = composeState;
  if (s.recipientMode === 'manual') return new Set(s.manualSelectedIds);
  const pool = allCustomers.filter(c => s.recipientMode === 'all' || c.payment_cycle === s.recipientMode);
  return new Set(pool.filter(c => !s.excludedIds.has(c.id)).map(c => c.id));
}

function renderManualSelect(card, data) {
  const wrap = card.querySelector('#cmp-manual-wrap');
  const s = composeState;
  wrap.innerHTML = `
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input type="text" id="cmp-manual-search" placeholder="ابحث عن زبون..." value="${escapeHtml(s.manualQuery)}">
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      <span class="meta" style="font-weight:700;">تم تحديد <span id="cmp-manual-count">${s.manualSelectedIds.size}</span> زبون</span>
      <span class="link" id="cmp-manual-selectall" style="font-size:12.5px;">تحديد الكل</span>
    </div>
    <div id="cmp-manual-results" style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;padding:4px;margin-bottom:12px;"></div>
  `;

  const renderResults = (q) => {
    const list = q ? data.allCustomers.filter(c => fuzzyMatch(c.name, q)) : data.allCustomers;
    const resultsEl = wrap.querySelector('#cmp-manual-results');
    resultsEl.innerHTML = list.length ? list.map(c => `
      <label style="display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid var(--border);cursor:pointer;">
        <input type="checkbox" class="cmp-manual-check" value="${c.id}" ${s.manualSelectedIds.has(c.id) ? 'checked' : ''}>
        <span style="flex:1;">${escapeHtml(c.name)}</span>
        <span class="meta">${db.formatMoneyPlain(c.balance)}</span>
      </label>`).join('') : `<p class="hint" style="padding:8px;">لا يوجد زبائن مطابقون</p>`;
    resultsEl.querySelectorAll('.cmp-manual-check').forEach(cb => cb.onchange = () => {
      if (cb.checked) s.manualSelectedIds.add(cb.value); else s.manualSelectedIds.delete(cb.value);
      wrap.querySelector('#cmp-manual-count').textContent = s.manualSelectedIds.size;
      updateSummary(card, data);
    });
  };
  renderResults(s.manualQuery);

  wrap.querySelector('#cmp-manual-search').oninput = debounce((e) => { s.manualQuery = e.target.value; renderResults(s.manualQuery); }, 150);
  wrap.querySelector('#cmp-manual-selectall').onclick = () => {
    data.allCustomers.forEach(c => s.manualSelectedIds.add(c.id));
    renderResults(wrap.querySelector('#cmp-manual-search').value);
    wrap.querySelector('#cmp-manual-count').textContent = s.manualSelectedIds.size;
    updateSummary(card, data);
  };
}

// "خيارات إضافية": استثناء زبائن محددين من الفئة المختارة حاليًا (نفس آلية excluded_customer_ids الحالية تمامًا)
function openExcludeSheet(container, data) {
  const s = composeState;
  const pool = data.allCustomers.filter(c => s.recipientMode === 'all' || c.payment_cycle === s.recipientMode);
  const overlay = openSheet(`
    <div class="sheet-header"><h3>خيارات إضافية</h3>${closeBtnHtml()}</div>
    <p class="hint" style="padding:0 4px;">فُك التحديد لاستثناء زبون من هذه الرسالة فقط (يبقى ضمن فئته بالجدولات القادمة)</p>
    <div style="max-height:320px;overflow-y:auto;border:1px solid var(--border);border-radius:10px;padding:4px;margin-bottom:14px;">
      ${pool.length ? pool.map(c => `
        <label style="display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid var(--border);cursor:pointer;">
          <input type="checkbox" class="excl-check" value="${c.id}" ${s.excludedIds.has(c.id) ? '' : 'checked'}>
          <span style="flex:1;">${escapeHtml(c.name)}</span>
          <span class="meta">${db.formatMoneyPlain(c.balance)}</span>
        </label>`).join('') : `<p class="hint" style="padding:8px;">لا يوجد زبائن بهذه الفئة</p>`}
    </div>
    <button class="btn btn-primary btn-block" id="excl-save">تطبيق</button>
  `);
  overlay.querySelector('[data-detail-close]').onclick = closeSheet;
  overlay.querySelector('#excl-save').onclick = () => {
    s.excludedIds = new Set(Array.from(overlay.querySelectorAll('.excl-check')).filter(cb => !cb.checked).map(cb => cb.value));
    closeSheet();
    const card = container.querySelector('#sms-compose-card');
    if (card) updateSummary(card, data);
  };
}

function updateSummary(card, data) {
  const s = composeState;
  const summaryEl = card.querySelector('#cmp-summary');
  const sendBtn = card.querySelector('#cmp-send-btn');
  if (!summaryEl) return;

  const recipientIds = currentRecipientIds(data.allCustomers);
  const count = recipientIds.size;
  const timingLabel = s.timing === 'now'
    ? 'الآن'
    : (s.laterDate && s.laterTime ? formatDateTime(new Date(`${s.laterDate}T${s.laterTime}`).toISOString()) : 'حدد التاريخ والوقت');

  summaryEl.innerHTML = `
    <div class="row"><span>👥 المستلمون</span><span>${count} زبون</span></div>
    <div class="row"><span>💬 عدد الرسائل</span><span>${count} رسالة</span></div>
    <div class="row grand"><span>📅 الموعد</span><span>${timingLabel}</span></div>
  `;

  const valid = !!s.templateId && count > 0 && (s.timing === 'now' || (s.laterDate && s.laterTime));
  if (sendBtn) sendBtn.disabled = !valid;
}

async function handleSend(container, data) {
  const card = container.querySelector('#sms-compose-card');
  const s = composeState;
  const recipientIds = currentRecipientIds(data.allCustomers);
  if (!s.templateId) return toastError('اختر قالب الرسالة');
  if (!recipientIds.size) return toastError('اختر مستلمين أولًا');
  if (s.timing === 'later' && (!s.laterDate || !s.laterTime)) return toastError('حدد تاريخ ووقت الإرسال');

  // نافذة التأكيد مطلوبة فقط عند إرسال/جدولة جديدة؛ تعديل جدولة قائمة أصلًا هو "حفظ إعدادات" لا "إرسال فوري"
  if (!s.editingScheduleId) {
    const ok = await confirmDialog({
      title: 'تأكيد الإرسال',
      message: `سيتم إرسال الرسالة إلى ${recipientIds.size} زبونًا ${s.timing === 'now' ? 'الآن' : 'بالموعد المحدد'}.`,
      confirmLabel: 'تأكيد الإرسال', danger: false
    });
    if (!ok) return;
  }

  const btn = card.querySelector('#cmp-send-btn');
  setLoading(btn, true, 'جاري الحفظ...');
  try {
    const scheduledAt = s.timing === 'now' ? new Date().toISOString() : new Date(`${s.laterDate}T${s.laterTime}`).toISOString();
    let target, excludedCustomerIds;
    if (s.recipientMode === 'manual') {
      target = 'all';
      excludedCustomerIds = data.allCustomers.filter(c => !s.manualSelectedIds.has(c.id)).map(c => c.id);
    } else {
      target = s.recipientMode;
      excludedCustomerIds = Array.from(s.excludedIds);
    }
    const payload = { name: s.name.trim(), templateId: s.templateId, target, scheduledAt, recurring: s.recurring, excludedCustomerIds };
    if (s.editingScheduleId) await db.updateSmsSchedule(s.editingScheduleId, payload);
    else await db.addSmsSchedule(payload);
    toastSuccess(s.editingScheduleId ? 'تم حفظ التعديلات' : (s.timing === 'now' ? 'جاري الإرسال الآن (خلال دقائق قليلة)' : 'تم حفظ الجدولة'));
    renderSms(container);
  } catch (err) {
    toastError(err.message || 'حدث خطأ أثناء الحفظ');
    setLoading(btn, false);
  }
}

// تعديل جدولة قائمة: يحمّل بياناتها بقسم "إرسال رسالة جديدة" (نفس القيود: target الأصلي يبقى
// all/weekly/monthly كما هو مخزَّن - "تحديد يدوي" أسلوب عرض فقط بالواجهة، يُحفَظ دائمًا كـall+استثناءات)
function startEditSchedule(container, data, schedule) {
  const [datePart, timePart] = toDatetimeLocalValue(schedule.scheduled_at).split('T');
  composeState = {
    editingScheduleId: schedule.id,
    templateId: schedule.template_id,
    recipientMode: schedule.target,
    excludedIds: new Set(schedule.excluded_customer_ids || []),
    manualSelectedIds: new Set(),
    manualQuery: '',
    timing: 'later',
    laterDate: datePart,
    laterTime: timePart,
    recurring: schedule.recurring,
    name: schedule.name || ''
  };
  renderComposeCard(container, data);
  container.querySelector('#sms-compose-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ============================================================
// إدارة القوالب
// ============================================================

function openManageTemplatesSheet(container, data) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>إدارة القوالب</h3>${closeBtnHtml()}</div>
    <div class="card" style="padding:6px 10px;max-height:60vh;overflow-y:auto;" id="tpl-manage-list">
      ${data.templates.length ? data.templates.map(t => templateRow(t)).join('') : emptyState('✉️', 'لا توجد قوالب بعد')}
    </div>
    <button class="btn btn-primary btn-block" style="margin-top:12px;" id="tpl-manage-add">+ إضافة قالب</button>
  `);
  overlay.querySelector('[data-detail-close]').onclick = closeSheet;
  overlay.querySelector('#tpl-manage-add').onclick = () => openTemplateForm(container, null, data);
  overlay.querySelectorAll('[data-tpl-edit]').forEach(el => el.onclick = () => {
    const t = data.templates.find(x => x.id === el.dataset.tplEdit);
    openTemplateForm(container, t, data);
  });
  overlay.querySelectorAll('[data-tpl-delete]').forEach(el => el.onclick = async () => {
    const t = data.templates.find(x => x.id === el.dataset.tplDelete);
    const ok = await confirmDialog({ title: 'حذف قالب', message: `هل تريد حذف قالب "${t.name}"؟` });
    if (!ok) return;
    try {
      await db.deleteSmsTemplate(t.id);
      toastSuccess('تم حذف القالب');
      closeSheet();
      await refreshTemplatesAndCompose(container, data);
    } catch (err) { toastError(err.message || 'حدث خطأ أثناء الحذف'); }
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

// يحسب عدد الحروف وعدد رسائل SMS بنفس قاعدة الحساب الرسمية (db.countSmsSegments) - الطول الفعلي يختلف
// حسب قيم {name}/{amount}/{due_date} الحقيقية لكل زبون، هذا تقدير بناءً على نص القالب كما هو
function updateCharCounter(el, text) {
  const len = text.length;
  const segments = db.countSmsSegments(text);
  el.textContent = segments <= 1
    ? `${len} حرف تقريبًا - رسالة واحدة`
    : `${len} حرف تقريبًا - ${segments} رسائل (السعر يتضاعف حسب عدد الرسائل)`;
}

function openTemplateForm(container, template, data) {
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
      let saved;
      if (isEdit) saved = await db.updateSmsTemplate(template.id, { name, body });
      else saved = await db.addSmsTemplate({ name, body });
      closeSheet();
      toastSuccess(isEdit ? 'تم تحديث القالب' : 'تم إضافة القالب');
      await refreshTemplatesAndCompose(container, data, !isEdit ? saved.id : undefined);
    } catch (err) {
      toastError(err.message || 'حدث خطأ أثناء الحفظ');
      setLoading(btn, false);
    }
  };
}

// يعيد جلب القوالب فقط ويحدّث قسم "إرسال رسالة جديدة" مكانه بدون إعادة بناء الشاشة كاملة، حتى لا تُفقد
// اختيارات المستخدم الجارية (المستلمون المحدَّدون يدويًا، موعد الإرسال...) لمجرد إضافة/تعديل قالب
async function refreshTemplatesAndCompose(container, data, newTemplateId) {
  data.templates = await db.getSmsTemplates();
  if (newTemplateId !== undefined) {
    composeState.templateId = newTemplateId;
  } else if (composeState.templateId && !data.templates.some(t => t.id === composeState.templateId)) {
    composeState.templateId = null;
  }
  renderComposeCard(container, data);
}

// ============================================================
// الجدولات القائمة / الأرشيف / سجل الإرسال (وظائف محفوظة كما هي من الناحية المنطقية)
// ============================================================

function bindScheduleEvents(container, data) {
  container.querySelectorAll('[data-sch-edit]').forEach(el => el.onclick = () => {
    const s = data.schedules.find(x => x.id === el.dataset.schEdit);
    startEditSchedule(container, data, s);
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
    const s = data.schedules.find(x => x.id === el.dataset.schViewLog);
    openScheduleLogSheet(s, data.log);
  });
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

// البحث/الفلترة بسجل الإرسال تُحدّث فقط #log-list (عنصر الإدخال نفسه لا يُعاد إنشاؤه أبدًا) - آمن ضد فقدان الأحرف
function bindLogFilter(container, log) {
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

function closeBtnHtml() {
  return `<button class="icon-btn" data-detail-close title="إغلاق"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`;
}

// يحوّل تاريخ ISO لصيغة datetime-local (YYYY-MM-DDTHH:mm) بالتوقيت المحلي
function toDatetimeLocalValue(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

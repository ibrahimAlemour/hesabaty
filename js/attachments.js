// المرفقات (صور/PDF لفواتير الشراء وغيرها لاحقًا): جدول عام entity_type/entity_id + Supabase Storage
// تنبيه معماري: على عكس باقي التطبيق (أوف لاين-أولًا)، هذه ميزة أونلاين بحتة - الملف الفعلي لا يُخزَّن
// محليًا بالجهاز أبدًا (حتى لا يتضخم حجم التخزين المحلي بلا داعٍ)، فرفع/عرض المرفق يحتاجان اتصالًا فعليًا بالإنترنت
import * as remoteDb from './db-supabase.js';
import { getSettings } from './database.js';
import { getCurrentUser, canDelete } from './auth.js';
import { uuid, nowISO, escapeHtml } from './utils.js';
import { toastError, toastSuccess, confirmDialog, setLoading } from './ui.js';

const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8 ميجابايت لكل ملف - كافٍ لصورة فاتورة بجودة جيدة بدون إبطاء الرفع
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];

function isAvailable() {
  return navigator.onLine && !!remoteDb.getClient();
}

// اسم ملف آمن للمسار (بدون مسافات/رموز خاصة قد تكسر الرابط)، مع الاحتفاظ بالامتداد
function safeFileName(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot > -1 ? name.slice(dot) : '';
  const base = (dot > -1 ? name.slice(0, dot) : name).replace(/[^a-zA-Z0-9؀-ۿ_-]/g, '_').slice(0, 60);
  return `${base || 'file'}${ext}`;
}

export async function uploadAttachment(entityType, entityId, file) {
  if (!isAvailable()) throw new Error('المرفقات تحتاج اتصالًا بالإنترنت. حاول مرة أخرى بعد التأكد من الاتصال.');
  if (file.size > MAX_FILE_SIZE) throw new Error('حجم الملف كبير جدًا (الحد الأقصى 8 ميجابايت)');
  if (ALLOWED_TYPES.length && file.type && !ALLOWED_TYPES.includes(file.type)) {
    throw new Error('نوع الملف غير مدعوم. يُسمح فقط بالصور أو ملفات PDF');
  }

  const s = await getSettings();
  if (!s.currentShopId) throw new Error('لم يتم تحديد المحل بعد');

  const path = `${s.currentShopId}/${entityType}/${entityId}/${uuid()}-${safeFileName(file.name)}`;
  await remoteDb.uploadAttachmentFile(path, file);

  const record = {
    id: uuid(),
    shop_id: s.currentShopId,
    entity_type: entityType,
    entity_id: entityId,
    storage_path: path,
    file_name: file.name,
    mime_type: file.type || '',
    size_bytes: file.size,
    created_by: s.currentUser?.name || 'مستخدم',
    created_at: nowISO()
  };
  await remoteDb.insertAttachment(record);
  return record;
}

// null = غير متاح حاليًا (بدون إنترنت)، وليس بالضرورة "لا توجد مرفقات" - الواجهة يجب أن تفرّق بينهما
export async function getAttachmentsFor(entityType, entityId) {
  if (!isAvailable()) return null;
  try {
    return await remoteDb.getAttachments(entityType, entityId);
  } catch (e) {
    console.error('فشل جلب المرفقات', e);
    return null;
  }
}

export async function deleteAttachment(record) {
  if (!isAvailable()) throw new Error('حذف المرفقات يحتاج اتصالًا بالإنترنت');
  await remoteDb.removeAttachmentFile(record.storage_path);
  await remoteDb.deleteAttachmentRow(record.id);
}

export async function openAttachment(record) {
  try {
    const url = await remoteDb.getAttachmentSignedUrl(record.storage_path);
    window.open(url, '_blank');
  } catch (e) {
    toastError('تعذر فتح المرفق. تأكد من الاتصال بالإنترنت وحاول مرة أخرى.');
  }
}

function fileIcon(mimeType) {
  if ((mimeType || '').startsWith('image/')) return '🖼️';
  if (mimeType === 'application/pdf') return '📄';
  return '📎';
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} كيلوبايت`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ميجابايت`;
}

// مكوّن واجهة قابل لإعادة الاستخدام: يُستدعى من أي شاشة عرض/تعديل تريد قسم مرفقات (حاليًا فاتورة الشراء فقط)
// entityId يجب أن يكون لسجل محفوظ فعليًا (لا يعمل لفاتورة جديدة لم تُحفظ بعد، لأنه لا يوجد معرّف ثابت لها)
export async function renderAttachmentsSection(container, entityType, entityId) {
  const section = document.createElement('div');
  section.className = 'card';
  section.innerHTML = `<div class="skeleton" style="height:60px;"></div>`;
  container.appendChild(section);

  const user = await getCurrentUser();
  const canManage = canDelete(user);
  const attachments = await getAttachmentsFor(entityType, entityId);
  renderContent();

  function renderContent() {
    if (attachments === null) {
      section.innerHTML = `
        <div class="section-title" style="margin-top:0;">📎 مرفقات الفاتورة</div>
        <p style="font-size:12.5px;color:var(--text-muted);margin:0;">المرفقات تحتاج اتصالًا بالإنترنت لعرضها أو إضافتها. تحقق من اتصالك وحاول مرة أخرى.</p>
      `;
      return;
    }
    section.innerHTML = `
      <div class="section-title" style="margin-top:0;">📎 مرفقات الفاتورة</div>
      ${attachments.length ? attachments.map(rowHtml).join('') : `<p style="font-size:12.5px;color:var(--text-muted);margin:0 0 10px;">لا توجد مرفقات بعد</p>`}
      <button class="btn btn-secondary btn-block" id="add-attachment-btn">+ إضافة مرفق</button>
      <input type="file" id="attachment-file-input" accept="image/*,application/pdf" capture="environment" style="display:none;">
    `;
    section.querySelectorAll('[data-att-open]').forEach(el => el.onclick = () => {
      const rec = attachments.find(a => a.id === el.dataset.attOpen);
      if (rec) openAttachment(rec);
    });
    if (canManage) {
      section.querySelectorAll('[data-att-delete]').forEach(el => el.onclick = async (ev) => {
        ev.stopPropagation();
        const rec = attachments.find(a => a.id === el.dataset.attDelete);
        if (!rec) return;
        const ok = await confirmDialog({ title: 'حذف المرفق', message: `هل تريد حذف "${rec.file_name}"؟` });
        if (!ok) return;
        try {
          await deleteAttachment(rec);
          toastSuccess('تم حذف المرفق');
          attachments.splice(attachments.indexOf(rec), 1);
          renderContent();
        } catch (err) {
          toastError(err.message || 'حدث خطأ أثناء الحذف');
        }
      });
    }
    const addBtn = section.querySelector('#add-attachment-btn');
    const fileInput = section.querySelector('#attachment-file-input');
    addBtn.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      setLoading(addBtn, true, 'جاري الرفع...');
      try {
        const record = await uploadAttachment(entityType, entityId, file);
        attachments.push(record);
        toastSuccess('تم رفع المرفق');
        renderContent();
      } catch (err) {
        toastError(err.message || 'حدث خطأ أثناء رفع المرفق');
        setLoading(addBtn, false);
      }
    };
  }

  function rowHtml(rec) {
    return `
      <div class="list-item" style="cursor:pointer;" data-att-open="${rec.id}">
        <div class="avatar">${fileIcon(rec.mime_type)}</div>
        <div class="info">
          <div class="title">${escapeHtml(rec.file_name)}</div>
          <div class="subtitle">${formatSize(rec.size_bytes)}</div>
        </div>
        ${canManage ? `<button class="remove-btn" data-att-delete="${rec.id}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
        </button>` : ''}
      </div>`;
  }
}

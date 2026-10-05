// مكونات واجهة مشتركة: Toast, Modal/Sheet, Confirm
import { escapeHtml } from './utils.js';

let toastContainer;
function ensureToastContainer() {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

const ICONS = {
  success: '✅', error: '⚠️', warning: '⚠️', info: 'ℹ️'
};

export function showToast(message, type = 'success', duration = 2600) {
  const container = ensureToastContainer();
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${ICONS[type] || ''}</span><span>${escapeHtml(message)}</span>`;
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, duration);
}

export function toastSuccess(msg) { showToast(msg, 'success'); }
export function toastError(msg) { showToast(msg, 'error'); }
export function toastWarning(msg) { showToast(msg, 'warning'); }

let activeOverlay = null;

export function openSheet(innerHtml, { onOpen, closeOnBackdrop = true, id = '' } = {}) {
  closeSheet();
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  if (id) overlay.id = id;
  overlay.innerHTML = `<div class="sheet"><div class="sheet-handle"></div>${innerHtml}</div>`;
  document.body.appendChild(overlay);
  activeOverlay = overlay;
  if (closeOnBackdrop) {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });
  }
  requestAnimationFrame(() => overlay.classList.add('show'));
  if (onOpen) onOpen(overlay);
  return overlay;
}

export function closeSheet() {
  if (activeOverlay) {
    const el = activeOverlay;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
    activeOverlay = null;
  }
}

export function confirmDialog({ title = 'تأكيد', message = 'هل أنت متأكد؟', confirmLabel = 'حذف', cancelLabel = 'إلغاء', danger = true } = {}) {
  return new Promise((resolve) => {
    const overlay = openSheet(`
      <div class="confirm-box">
        <div class="icon-circle" style="${danger ? '' : 'background:var(--primary-light);color:var(--primary-dark);'}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4m0 4h.01M10.29 3.86l-8.02 13.9A1.5 1.5 0 003.55 20h16.9a1.5 1.5 0 001.28-2.24l-8.02-13.9a1.5 1.5 0 00-2.56 0z"/></svg>
        </div>
        <h3 style="margin:0 0 4px;font-size:16.5px;font-weight:800;">${escapeHtml(title)}</h3>
        <p>${escapeHtml(message)}</p>
        <div class="confirm-actions">
          <button class="btn btn-secondary" data-act="cancel">${escapeHtml(cancelLabel)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="confirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>
    `);
    overlay.querySelector('[data-act="cancel"]').onclick = () => { closeSheet(); resolve(false); };
    overlay.querySelector('[data-act="confirm"]').onclick = () => { closeSheet(); resolve(true); };
  });
}

export function setLoading(button, loading, label) {
  if (!button) return;
  if (loading) {
    button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="loading-spinner"></span> ${label || ''}`;
  } else {
    button.disabled = false;
    if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
  }
}

export function emptyState(icon, text, subtext = '') {
  return `<div class="empty-state">
    <div style="font-size:44px;">${icon}</div>
    <p style="font-weight:700;color:var(--text);">${escapeHtml(text)}</p>
    ${subtext ? `<p>${escapeHtml(subtext)}</p>` : ''}
  </div>`;
}

// يعرض أول دفعة فقط من قائمة طويلة (بدل بناء DOM ضخم لآلاف العناصر دفعة واحدة) مع زر "عرض المزيد"
// يوسّع الدفعة تدريجيًا. البيانات نفسها تُجلب كاملة كما هي الآن (لا تغيير بمنطق الجلب)؛ فقط الرسم بالشاشة
// يتم تدريجيًا. onRender يُستدعى بعد كل رسم (أولي أو توسيع) لإعادة ربط أحداث الصفوف (data-edit...الخ)
export function renderPaginatedList(resultsEl, items, rowFn, { pageSize = 30, emptyIcon = '📭', emptyText = 'لا توجد نتائج', emptySubtext = '', onRender } = {}) {
  if (!items.length) { resultsEl.innerHTML = emptyState(emptyIcon, emptyText, emptySubtext); if (onRender) onRender(); return; }
  let shown = Math.min(pageSize, items.length);
  const draw = () => {
    const remaining = items.length - shown;
    resultsEl.innerHTML = items.slice(0, shown).map(rowFn).join('') +
      (remaining > 0 ? `<button class="btn btn-secondary btn-block" data-load-more style="margin-top:10px;">عرض المزيد (${remaining} متبقي)</button>` : '');
    const btn = resultsEl.querySelector('[data-load-more]');
    if (btn) btn.onclick = () => { shown = Math.min(shown + pageSize, items.length); draw(); };
    if (onRender) onRender();
  };
  draw();
}

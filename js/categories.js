// شاشة إدارة التصنيفات: إضافة، تعديل، حذف، واختيار ملصق تعبيري (إيموجي) لكل تصنيف
import * as db from './database.js';
import { getCurrentUser, canDelete } from './auth.js';
import { escapeHtml } from './utils.js';
import { toastError, toastSuccess, setLoading, openSheet, closeSheet, confirmDialog, emptyState } from './ui.js';

export async function renderCategories(container) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const [categories, user] = await Promise.all([db.getCategories(), getCurrentUser()]);
  const canManage = canDelete(user);

  container.innerHTML = `
    ${canManage ? `<button class="btn btn-primary btn-block" id="add-cat-btn" style="margin-bottom:14px;">+ إضافة تصنيف</button>` : ''}
    <div class="card" style="padding:6px 10px;">
      ${categories.length ? categories.map(c => categoryRow(c, canManage)).join('') : emptyState('🏷️', 'لا توجد تصنيفات')}
    </div>
  `;

  const addBtn = container.querySelector('#add-cat-btn');
  if (addBtn) addBtn.onclick = () => openCategoryForm(container, null, () => renderCategories(container));
  container.querySelectorAll('[data-cat-edit]').forEach(btn => btn.onclick = () => {
    const c = categories.find(x => x.id === btn.dataset.catEdit);
    openCategoryForm(container, c, () => renderCategories(container));
  });
  container.querySelectorAll('[data-cat-delete]').forEach(btn => btn.onclick = async () => {
    const c = categories.find(x => x.id === btn.dataset.catDelete);
    const ok = await confirmDialog({ title: 'حذف تصنيف', message: `هل تريد حذف "${c.name}"؟` });
    if (!ok) return;
    try {
      await db.deleteCategory(c.id);
      toastSuccess('تم حذف التصنيف');
      renderCategories(container);
    } catch (err) {
      toastError(err.message || 'حدث خطأ أثناء الحذف');
    }
  });
}

function categoryRow(c, canManage) {
  return `
    <div class="list-item">
      <div class="avatar">${escapeHtml(c.icon || '📦')}</div>
      <div class="info"><div class="title">${escapeHtml(c.name)}</div></div>
      ${canManage ? `
      <button class="icon-btn" data-cat-edit="${c.id}" title="تعديل"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
      <button class="remove-btn" data-cat-delete="${c.id}" title="حذف"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></button>
      ` : ''}
    </div>`;
}

function openCategoryForm(container, category, onSaved) {
  const isEdit = !!category;
  const overlay = openSheet(`
    <div class="sheet-header"><h3>${isEdit ? 'تعديل تصنيف' : '+ إضافة تصنيف'}</h3></div>
    <div class="form-group"><label>اسم التصنيف</label><input type="text" id="cf-name" value="${isEdit ? escapeHtml(category.name) : ''}" placeholder="مثال: مشروبات"></div>
    <div class="form-group">
      <label>الملصق التعبيري (إيموجي)</label>
      <input type="text" id="cf-icon" value="${isEdit ? escapeHtml(category.icon || '') : ''}" placeholder="📦" style="font-size:22px;text-align:center;" maxlength="4">
      <p class="hint">اضغط زر الإيموجي 😊 بلوحة المفاتيح واختر أي ملصق يناسب التصنيف</p>
    </div>
    <button class="btn btn-primary btn-block" id="cf-save">${isEdit ? 'حفظ التعديلات' : 'إضافة التصنيف'}</button>
  `, { onOpen: (el) => el.querySelector('#cf-name').focus() });

  overlay.querySelector('#cf-save').onclick = async () => {
    const btn = overlay.querySelector('#cf-save');
    const name = overlay.querySelector('#cf-name').value.trim();
    const icon = overlay.querySelector('#cf-icon').value.trim();
    if (!name) return toastError('أدخل اسم التصنيف');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      if (isEdit) await db.updateCategory(category.id, { name, icon }); else await db.addCategory({ name, icon });
      closeSheet();
      toastSuccess(isEdit ? 'تم تحديث التصنيف' : 'تم إضافة التصنيف');
      onSaved();
    } catch (err) {
      toastError(err.message || 'حدث خطأ أثناء الحفظ');
      setLoading(btn, false);
    }
  };
}

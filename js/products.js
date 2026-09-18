// إدارة المنتجات: إضافة، تعديل، حذف، إيقاف، بحث، تصنيفات
import * as db from './database.js';
import { getCurrentUser, canDelete } from './auth.js';
import { formatMoney, escapeHtml, fuzzyMatch, debounce, UNITS } from './utils.js';
import { toastError, toastSuccess, setLoading, openSheet, closeSheet, confirmDialog, emptyState } from './ui.js';

let currentCategory = 'all';
let currentQuery = '';

export async function renderProductList(container) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const [products, categories, user] = await Promise.all([db.getProducts(), db.getCategories(), getCurrentUser()]);
  container._categories = categories;
  container._canManage = canDelete(user);
  renderList(container, products);
}

function renderList(container, products) {
  const categories = container._categories;
  let filtered = products;
  if (currentCategory !== 'all') filtered = filtered.filter(p => p.category_id === currentCategory);
  if (currentQuery) filtered = filtered.filter(p => fuzzyMatch(p.name, currentQuery));

  container.innerHTML = `
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input type="text" id="product-search" placeholder="ابحث عن منتج..." value="${escapeHtml(currentQuery)}">
    </div>
    <div class="tabs">
      <button class="tab-btn ${currentCategory === 'all' ? 'active' : ''}" data-cat="all">الكل</button>
      ${categories.map(c => `<button class="tab-btn ${currentCategory === c.id ? 'active' : ''}" data-cat="${c.id}">${c.icon} ${c.name}</button>`).join('')}
    </div>
    <button class="btn btn-primary btn-block" id="add-product-btn" style="margin-bottom:14px;">+ إضافة منتج</button>
    <div class="card" style="padding:6px 10px;">
      ${filtered.length ? filtered.map(p => productRow(p, categories)).join('') : emptyState('📦', 'لا توجد منتجات')}
    </div>
  `;

  container.querySelector('#product-search').oninput = debounce((e) => { currentQuery = e.target.value; renderList(container, products); }, 150);
  container.querySelectorAll('[data-cat]').forEach(btn => btn.onclick = () => { currentCategory = btn.dataset.cat; renderList(container, products); });
  container.querySelector('#add-product-btn').onclick = () => openProductForm(container, null, () => renderProductList(container));
  container.querySelectorAll('[data-edit]').forEach(el => el.onclick = () => {
    const p = products.find(x => x.id === el.dataset.edit);
    openProductForm(container, p, () => renderProductList(container));
  });
}

function productRow(p, categories) {
  const cat = categories.find(c => c.id === p.category_id);
  return `
    <div class="list-item" style="cursor:pointer;${p.is_active === false ? 'opacity:.5;' : ''}" data-edit="${p.id}">
      <div class="avatar">${cat ? cat.icon : '📦'}</div>
      <div class="info">
        <div class="title">${escapeHtml(p.name)} ${p.is_active === false ? '<span class="badge" style="background:var(--border);color:var(--text-muted);">متوقف</span>' : ''}</div>
        <div class="subtitle">${p.unit} - شراء ${formatMoney(p.cost_price)} / بيع ${formatMoney(p.selling_price)}</div>
      </div>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-muted)"><path d="M9 6l6 6-6 6"/></svg>
    </div>`;
}

function openProductForm(container, product, onSaved) {
  const categories = container._categories;
  const isEdit = !!product;
  const overlay = openSheet(`
    <div class="sheet-header"><h3>${isEdit ? 'تعديل منتج' : '+ إضافة منتج'}</h3></div>
    <div class="form-group"><label>اسم المنتج</label><input type="text" id="pf-name" value="${isEdit ? escapeHtml(product.name) : ''}" placeholder="اسم المنتج"></div>
    <div class="form-group"><label>التصنيف</label>
      <select id="pf-category">${categories.map(c => `<option value="${c.id}" ${isEdit && product.category_id === c.id ? 'selected' : ''}>${c.icon} ${c.name}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label>الوحدة</label>
      <select id="pf-unit">${UNITS.map(u => `<option value="${u}" ${isEdit && product.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label>سعر الشراء</label><input type="number" id="pf-cost" step="0.5" min="0" value="${isEdit ? product.cost_price / 100 : ''}"></div>
    <div class="form-group"><label>سعر البيع</label><input type="number" id="pf-price" step="0.5" min="0" value="${isEdit ? product.selling_price / 100 : ''}"></div>
    <div class="form-group"><label>ملاحظات (اختياري)</label><textarea id="pf-notes">${isEdit ? escapeHtml(product.notes || '') : ''}</textarea></div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;margin-bottom:16px;">
      <input type="checkbox" id="pf-quick" ${isEdit && product.quick_access ? 'checked' : ''}> إظهار كاختصار سريع في شاشة البيع
    </label>
    <button class="btn btn-primary btn-block" id="pf-save">${isEdit ? 'حفظ التعديلات' : 'إضافة المنتج'}</button>
    ${isEdit ? `
    <button class="btn btn-secondary btn-block" style="margin-top:8px;" id="pf-toggle">${product.is_active === false ? 'تفعيل المنتج' : 'إيقاف المنتج'}</button>
    ${container._canManage ? `<button class="btn btn-danger btn-block" style="margin-top:8px;" id="pf-delete">حذف المنتج</button>` : ''}` : ''}
  `, { onOpen: (el) => el.querySelector('#pf-name').focus() });

  overlay.querySelector('#pf-save').onclick = async () => {
    const btn = overlay.querySelector('#pf-save');
    const name = overlay.querySelector('#pf-name').value.trim();
    const price = parseFloat(overlay.querySelector('#pf-price').value);
    if (!name) return toastError('أدخل اسم المنتج');
    if (!price || price <= 0) return toastError('أدخل سعر بيع صحيح');
    const data = {
      name, category_id: overlay.querySelector('#pf-category').value, unit: overlay.querySelector('#pf-unit').value,
      cost_price: parseFloat(overlay.querySelector('#pf-cost').value) || 0, selling_price: price,
      notes: overlay.querySelector('#pf-notes').value.trim(), quick_access: overlay.querySelector('#pf-quick').checked
    };
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      if (isEdit) await db.updateProduct(product.id, data); else await db.addProduct(data);
      closeSheet();
      toastSuccess(isEdit ? 'تم تحديث المنتج' : 'تم إضافة المنتج');
      onSaved();
    } catch (err) {
      toastError('حدث خطأ أثناء الحفظ. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };

  if (isEdit) {
    overlay.querySelector('#pf-toggle').onclick = async () => {
      await db.updateProduct(product.id, { is_active: product.is_active === false });
      closeSheet();
      toastSuccess('تم تحديث حالة المنتج');
      onSaved();
    };
    const deleteBtn = overlay.querySelector('#pf-delete');
    if (deleteBtn) deleteBtn.onclick = async () => {
      const ok = await confirmDialog({ title: 'حذف المنتج', message: `هل تريد حذف ${product.name}؟` });
      if (!ok) return;
      await db.deleteProduct(product.id);
      closeSheet();
      toastSuccess('تم حذف المنتج');
      onSaved();
    };
  }
}

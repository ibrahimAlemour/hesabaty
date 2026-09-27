// شاشات فواتير المشتريات: قائمة الفواتير، إضافة/تعديل فاتورة شراء، عرض الفاتورة
// المقصود بفواتير الشراء هنا: الفواتير التي يشتري بها صاحب المحل البضاعة من الموردين، وليست فواتير بيع للزبائن
import * as db from './database.js';
import { canDelete, getCurrentUser } from './auth.js';
import { toastError, toastSuccess, toastWarning, openSheet, closeSheet, setLoading, confirmDialog, emptyState } from './ui.js';
import { formatMoney, formatDateTime, toCents, fromCents, escapeHtml, fuzzyMatch, debounce, UNITS } from './utils.js';
import { renderAttachmentsSection } from './attachments.js';

let purchaseState;
let editingPurchaseId = null;

function freshState() {
  return {
    supplier: null, supplierInvoiceNumber: '', purchaseDate: todayInputValue(), dueDate: '',
    items: [], discount: 0, extraCosts: 0,
    payMode: 'single', activeMethod: 'cash', split: { cash: 0, transfer: 0, credit: 0 }, notes: ''
  };
}

function todayInputValue(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toISOString().slice(0, 10);
}

// ---------- قائمة فواتير الشراء ----------
export async function renderPurchaseList(container) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const purchases = await db.getPurchases();
  renderListScreen(container, purchases, '');
}

function renderListScreen(container, purchases, query) {
  const filtered = query
    ? purchases.filter(p => fuzzyMatch(p.supplier_name_snapshot, query) || (p.purchase_number || '').includes(query) || (p.supplier_invoice_number || '').includes(query))
    : purchases;
  container.innerHTML = `
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input type="text" id="purchase-search" placeholder="ابحث باسم المورد أو رقم الفاتورة..." value="${escapeHtml(query)}">
    </div>
    <button class="btn btn-primary btn-block" id="add-purchase-btn" style="margin-bottom:14px;">+ إضافة فاتورة شراء</button>
    <div class="card" style="padding:6px 10px;">
      ${filtered.length ? filtered.map(purchaseRow).join('') : emptyState('🧾', 'لا توجد فواتير شراء', 'أضف أول فاتورة شراء للبدء')}
    </div>
  `;
  container.querySelector('#purchase-search').oninput = debounce((e) => renderListScreen(container, purchases, e.target.value), 150);
  container.querySelector('#add-purchase-btn').onclick = () => window.location.hash = '#/purchase/new';
  container.querySelectorAll('[data-open]').forEach(el => el.onclick = () => window.location.hash = `#/purchase/${el.dataset.open}`);
}

const STATUS_BADGE = {
  paid: '<span class="badge cash">مدفوعة</span>',
  partial: '<span class="badge partial">جزئي</span>',
  credit: '<span class="badge debt">آجل</span>'
};

function purchaseRow(p) {
  return `
    <div class="list-item" style="cursor:pointer;" data-open="${p.id}">
      <div class="avatar">🧾</div>
      <div class="info">
        <div class="title">${escapeHtml(p.supplier_name_snapshot)}</div>
        <div class="subtitle">${p.purchase_number} · ${formatDateTime(p.created_at)}</div>
      </div>
      <div style="text-align:left;display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
        <div class="amount">${formatMoney(p.total_amount)}</div>
        ${STATUS_BADGE[p.payment_status] || ''}
      </div>
    </div>`;
}

// ---------- إضافة / تعديل فاتورة شراء ----------
export async function renderNewPurchase(container, presetSupplierId) {
  editingPurchaseId = null;
  purchaseState = freshState();
  const [allProducts, categories] = await Promise.all([db.getProducts({ activeOnly: true }), db.getCategories()]);
  container._allProducts = allProducts;
  container._categoryIcons = new Map(categories.map(c => [c.id, c.icon]));
  if (presetSupplierId) {
    const supplier = await db.getSupplier(presetSupplierId);
    if (supplier) purchaseState.supplier = supplier;
  }
  renderPurchaseScreen(container);
}

export async function renderEditPurchase(container, purchaseId) {
  const purchase = await db.getPurchase(purchaseId);
  if (!purchase) return toastError('فاتورة الشراء غير موجودة');
  editingPurchaseId = purchaseId;
  const [allProducts, categories, supplier] = await Promise.all([
    db.getProducts({ activeOnly: true }), db.getCategories(), db.getSupplier(purchase.supplier_id)
  ]);
  container._allProducts = allProducts;
  container._categoryIcons = new Map(categories.map(c => [c.id, c.icon]));
  purchaseState = {
    supplier: supplier || null,
    supplierInvoiceNumber: purchase.supplier_invoice_number || '',
    purchaseDate: todayInputValue(purchase.purchase_date),
    dueDate: purchase.due_date ? todayInputValue(purchase.due_date) : '',
    items: purchase.items.map(it => ({
      product_id: it.product_id, product_name: it.product_name, quantity: it.quantity, unit: it.unit,
      purchase_price: fromCents(it.purchase_price), update_cost_price: false
    })),
    discount: fromCents(purchase.discount), extraCosts: fromCents(purchase.extra_costs),
    payMode: 'split', activeMethod: 'cash',
    split: { cash: purchase.paid_cash, transfer: purchase.paid_transfer, credit: purchase.paid_credit },
    notes: purchase.notes || ''
  };
  renderPurchaseScreen(container);
  const btn = container.querySelector('#complete-purchase-btn');
  if (btn) btn.textContent = 'حفظ التعديلات';
  renderAttachmentsSection(container, 'purchase', purchaseId);
}

function productEmoji(p, iconsMap) {
  return p.icon || (iconsMap && iconsMap.get(p.category_id)) || '📦';
}

function itemsSubtotal(items) {
  return items.reduce((s, it) => s + Math.round(toCents(it.purchase_price) * (parseFloat(it.quantity) || 0)), 0);
}

function finalTotal() {
  const subtotal = itemsSubtotal(purchaseState.items);
  return Math.max(0, subtotal - toCents(purchaseState.discount) + toCents(purchaseState.extraCosts));
}

function renderPurchaseScreen(container) {
  container.innerHTML = `
    <div class="card" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;" id="supplier-row">
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="avatar">${purchaseState.supplier ? escapeHtml(purchaseState.supplier.name[0]) : '🚚'}</div>
        <div>
          <div style="font-weight:700;font-size:14.5px;">${purchaseState.supplier ? escapeHtml(purchaseState.supplier.name) : 'بدون مورد محدد'}</div>
          <div style="font-size:12px;color:var(--text-muted);">${purchaseState.supplier ? 'اضغط لتغيير المورد' : 'اضغط لاختيار مورد'}</div>
        </div>
      </div>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-muted)"><path d="M9 6l6 6-6 6"/></svg>
    </div>

    <div class="form-group" style="margin-top:12px;">
      <label>رقم فاتورة المورد (اختياري)</label>
      <input type="text" id="p-supplier-invoice" placeholder="رقم الفاتورة كما هو مكتوب عند المورد" value="${escapeHtml(purchaseState.supplierInvoiceNumber)}">
    </div>
    <div style="display:flex;gap:10px;">
      <div class="form-group" style="flex:1;"><label>تاريخ الفاتورة</label><input type="date" id="p-date" value="${purchaseState.purchaseDate}"></div>
      <div class="form-group" style="flex:1;" id="p-due-date-group">
        <label>تاريخ الاستحقاق ${purchaseState.split.credit > 0 || purchaseState.activeMethod === 'credit' ? '' : '(للشراء الآجل)'}</label>
        <input type="date" id="p-due-date" value="${purchaseState.dueDate}">
      </div>
    </div>

    <div class="section-title" style="margin-top:14px;">المنتجات (${purchaseState.items.length})</div>
    <div class="card" id="items-card" style="padding:6px 10px;">
      ${renderItemsList()}
    </div>
    <button class="btn btn-secondary btn-block" id="add-item-btn" style="margin-bottom:14px;">+ إضافة منتج</button>

    <div class="totals-box">
      <div class="row"><span>إجمالي المنتجات</span><span id="tb-subtotal">${formatMoney(itemsSubtotal(purchaseState.items))}</span></div>
      <div class="row"><span>خصم</span><input type="number" id="p-discount" value="${purchaseState.discount || ''}" placeholder="0" step="0.5" min="0" style="width:90px;text-align:left;border:1px solid var(--border);border-radius:8px;padding:4px 8px;"></div>
      <div class="row"><span>تكاليف إضافية</span><input type="number" id="p-extra" value="${purchaseState.extraCosts || ''}" placeholder="0" step="0.5" min="0" style="width:90px;text-align:left;border:1px solid var(--border);border-radius:8px;padding:4px 8px;"></div>
      <div class="row grand"><span>الإجمالي النهائي</span><span id="tb-final">${formatMoney(finalTotal())}</span></div>
    </div>

    <div class="section-title">طريقة الدفع</div>
    <div class="pay-methods" id="pay-methods">
      <div class="pay-method-btn ${purchaseState.payMode==='single' && purchaseState.activeMethod==='cash' ? 'active':''}" data-method="cash"><span class="emoji">💵</span>نقدي</div>
      <div class="pay-method-btn ${purchaseState.payMode==='single' && purchaseState.activeMethod==='transfer' ? 'active':''}" data-method="transfer"><span class="emoji">📱</span>تحويل</div>
      <div class="pay-method-btn ${purchaseState.payMode==='single' && purchaseState.activeMethod==='credit' ? 'active':''}" data-method="credit"><span class="emoji">📝</span>آجل</div>
    </div>
    ${splitPayButtonHtml(purchaseState.payMode === 'split')}
    <div id="remaining-note" style="font-size:13px;font-weight:700;color:var(--danger);margin:8px 0;"></div>

    <div class="form-group" style="margin-top:14px;">
      <label>ملاحظات الفاتورة (اختياري)</label>
      <textarea id="p-notes" placeholder="أي ملاحظات على فاتورة الشراء">${escapeHtml(purchaseState.notes || '')}</textarea>
    </div>

    <button class="btn btn-primary btn-block" id="complete-purchase-btn" style="padding:16px;font-size:16px;">حفظ فاتورة الشراء</button>
  `;
  bindPurchaseScreen(container);
  updateRemainingNote(container);
}

function renderItemsList() {
  if (!purchaseState.items.length) return emptyState('📦', 'لم تُضف منتجات بعد', 'اضغط "+ إضافة منتج" للبدء');
  return purchaseState.items.map((it, idx) => {
    const hasQty = it.quantity !== '' && it.quantity != null;
    const totalValue = hasQty ? fromCents(Math.round(toCents(it.purchase_price) * it.quantity)) : '';
    return `
    <div class="sale-item-row" data-idx="${idx}" style="flex-direction:column;align-items:stretch;gap:8px;">
      <div style="display:flex;align-items:center;">
        <div class="prod-name" style="flex:1;">${escapeHtml(it.product_name)}</div>
        <button class="remove-btn" data-remove="${idx}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
        </button>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <input type="number" inputmode="decimal" class="item-qty" data-idx="${idx}" value="${it.quantity}" placeholder="الكمية" step="0.1" min="0.01" style="width:78px;padding:11px 8px;font-size:15.5px;" title="الكمية">
        <span class="prod-meta">${it.unit} ×</span>
        <input type="number" inputmode="decimal" class="item-price" data-idx="${idx}" value="${fromCents(toCents(it.purchase_price))}" step="0.5" min="0" style="width:78px;padding:11px 8px;font-size:15.5px;" title="سعر الشراء">
        <span class="prod-meta">₪ =</span>
        <input type="number" inputmode="decimal" class="item-total" data-idx="${idx}" value="${totalValue}" placeholder="الإجمالي" step="0.5" min="0" style="width:88px;padding:11px 8px;font-size:15.5px;font-weight:700;color:var(--primary-dark);" title="الإجمالي">
        <span class="prod-meta">₪</span>
      </div>
      ${it.product_id ? `
      <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text-muted);">
        <input type="checkbox" class="item-update-cost" data-idx="${idx}" ${it.update_cost_price ? 'checked' : ''}> تحديث سعر شراء المنتج بهذا السعر
      </label>` : ''}
    </div>`;
  }).join('');
}

function refreshItemsAndTotals(container) {
  container.querySelector('#items-card').innerHTML = renderItemsList();
  const titleEl = container.querySelector('.section-title');
  if (titleEl) titleEl.childNodes[0].textContent = `المنتجات (${purchaseState.items.length})`;
  bindItemInputs(container);
  updateTotals(container);
}

function bindItemInputs(container) {
  container.querySelectorAll('.item-qty').forEach(inp => inp.oninput = () => {
    const idx = +inp.dataset.idx;
    purchaseState.items[idx].quantity = parseFloat(inp.value) || 0;
    updateRowTotal(container, idx);
  });
  container.querySelectorAll('.item-price').forEach(inp => inp.oninput = () => {
    const idx = +inp.dataset.idx;
    purchaseState.items[idx].purchase_price = parseFloat(inp.value) || 0;
    updateRowTotal(container, idx);
  });
  container.querySelectorAll('.item-total').forEach(inp => inp.oninput = () => {
    const idx = +inp.dataset.idx;
    updateRowQuantityFromTotal(container, idx, parseFloat(inp.value) || 0);
  });
  container.querySelectorAll('.item-update-cost').forEach(inp => inp.onchange = () => {
    purchaseState.items[+inp.dataset.idx].update_cost_price = inp.checked;
  });
  container.querySelectorAll('[data-remove]').forEach(btn => btn.onclick = () => {
    purchaseState.items.splice(+btn.dataset.remove, 1);
    refreshItemsAndTotals(container);
  });
}

function updateRowTotal(container, idx) {
  const row = container.querySelector(`.sale-item-row[data-idx="${idx}"]`);
  const it = purchaseState.items[idx];
  const totalCents = Math.round(toCents(it.purchase_price) * it.quantity);
  row.querySelector('.item-total').value = fromCents(totalCents);
  updateTotals(container);
}

function updateRowQuantityFromTotal(container, idx, totalValue) {
  const row = container.querySelector(`.sale-item-row[data-idx="${idx}"]`);
  const it = purchaseState.items[idx];
  if (it.purchase_price > 0) {
    it.quantity = Math.round((totalValue / it.purchase_price) * 1000) / 1000;
    row.querySelector('.item-qty').value = it.quantity;
  }
  updateTotals(container);
}

function updateTotals(container) {
  const subtotal = itemsSubtotal(purchaseState.items);
  container.querySelector('#tb-subtotal').textContent = formatMoney(subtotal);
  container.querySelector('#tb-final').textContent = formatMoney(finalTotal());
  syncSingleMethodAmounts();
  updateRemainingNote(container);
}

function syncSingleMethodAmounts() {
  if (purchaseState.payMode !== 'single') return;
  const total = finalTotal();
  purchaseState.split = { cash: 0, transfer: 0, credit: 0 };
  purchaseState.split[purchaseState.activeMethod] = total;
}

function updateRemainingNote(container) {
  const note = container.querySelector('#remaining-note');
  if (!note) return;
  const credit = purchaseState.split.credit || 0;
  note.textContent = credit > 0 ? `المبلغ المتبقي (آجل للمورد): ${formatMoney(credit)}` : '';
  const dueGroup = container.querySelector('#p-due-date-group');
  if (dueGroup) dueGroup.style.display = credit > 0 ? '' : 'none';
}

function bindPurchaseScreen(container) {
  bindItemInputs(container);
  container.querySelector('#supplier-row').onclick = () => openSupplierSheet(container);
  container.querySelector('#add-item-btn').onclick = () => openProductSheet(container);
  container.querySelector('#p-supplier-invoice').oninput = (e) => purchaseState.supplierInvoiceNumber = e.target.value;
  container.querySelector('#p-date').onchange = (e) => purchaseState.purchaseDate = e.target.value;
  container.querySelector('#p-due-date').onchange = (e) => purchaseState.dueDate = e.target.value;
  container.querySelector('#p-discount').oninput = (e) => { purchaseState.discount = parseFloat(e.target.value) || 0; updateTotals(container); };
  container.querySelector('#p-extra').oninput = (e) => { purchaseState.extraCosts = parseFloat(e.target.value) || 0; updateTotals(container); };
  container.querySelector('#p-notes').oninput = (e) => purchaseState.notes = e.target.value;

  container.querySelectorAll('.pay-method-btn').forEach(btn => btn.onclick = () => {
    purchaseState.payMode = 'single';
    purchaseState.activeMethod = btn.dataset.method;
    syncSingleMethodAmounts();
    container.querySelectorAll('.pay-method-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    setSplitPayButtonState(container, false);
    updateRemainingNote(container);
    if (btn.dataset.method === 'credit') maybeCaptureSupplier(container);
  });

  container.querySelector('#split-pay-btn').onclick = () => openSplitPaymentSheet(container);
  container.querySelector('#complete-purchase-btn').onclick = () => completePurchase(container);
}

function maybeCaptureSupplier(container) {
  if (!purchaseState.supplier) {
    toastWarning('يجب اختيار مورد قبل تسجيل مبلغ آجل');
    openSupplierSheet(container);
  }
}

function openSplitPaymentSheet(container) {
  const total = finalTotal();
  const s = purchaseState.split;
  const overlay = openSheet(`
    <div class="sheet-header"><h3>تقسيم الدفع</h3></div>
    <div class="totals-box" style="margin-top:0;"><div class="row grand"><span>إجمالي الفاتورة</span><span>${formatMoney(total)}</span></div></div>
    <div class="form-group"><label>💵 نقدي</label><input type="number" id="sp-cash" value="${fromCents(s.cash)}" step="0.5" min="0"></div>
    <div class="form-group"><label>📱 تحويل</label><input type="number" id="sp-transfer" value="${fromCents(s.transfer)}" step="0.5" min="0"></div>
    <div class="form-group"><label>📝 آجل</label><input type="number" id="sp-credit" value="${fromCents(s.credit)}" step="0.5" min="0"></div>
    <div id="sp-remaining" style="font-size:13px;font-weight:700;margin-bottom:12px;"></div>
    <button class="btn btn-primary btn-block" id="sp-save">تأكيد التقسيم</button>
  `);

  const updateRemaining = () => {
    const cash = toCents(overlay.querySelector('#sp-cash').value || 0);
    const transfer = toCents(overlay.querySelector('#sp-transfer').value || 0);
    const credit = toCents(overlay.querySelector('#sp-credit').value || 0);
    const remaining = total - (cash + transfer + credit);
    const el = overlay.querySelector('#sp-remaining');
    el.textContent = remaining === 0 ? '✅ المبلغ مطابق للإجمالي' : `المتبقي: ${formatMoney(remaining)}`;
    el.style.color = remaining === 0 ? 'var(--success)' : 'var(--danger)';
    return { cash, transfer, credit, remaining };
  };
  ['sp-cash', 'sp-transfer', 'sp-credit'].forEach(id => overlay.querySelector(`#${id}`).oninput = updateRemaining);
  updateRemaining();

  overlay.querySelector('#sp-save').onclick = () => {
    const { cash, transfer, credit, remaining } = updateRemaining();
    if (remaining !== 0) return toastError('مجموع طرق الدفع يجب أن يساوي إجمالي الفاتورة');
    if (credit > 0 && !purchaseState.supplier) { toastWarning('يجب اختيار مورد قبل تسجيل مبلغ آجل'); return openSupplierSheet(container); }
    purchaseState.payMode = 'split';
    purchaseState.split = { cash, transfer, credit };
    closeSheet();
    setSplitPayButtonState(container, true);
    container.querySelectorAll('.pay-method-btn').forEach(b => b.classList.remove('active'));
    updateRemainingNote(container);
  };
}

function splitPayButtonHtml(isActive) {
  return `
    <button id="split-pay-btn" style="display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;background:var(--primary-light);border:none;border-radius:var(--radius-sm);padding:14px 16px;margin:4px 0 12px;cursor:pointer;font-family:inherit;">
      <span style="font-size:17px;">📊</span>
      <span id="split-pay-label" style="flex:1;text-align:center;font-weight:800;color:var(--primary-dark);font-size:14px;">${isActive ? '✓ الدفع مقسم - تعديل' : 'تقسيم الدفع على أكثر من طريقة'}</span>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:var(--primary-dark);flex-shrink:0;"><path d="M6 9l6 6 6-6"/></svg>
    </button>`;
}

function setSplitPayButtonState(container, isActive) {
  const label = container.querySelector('#split-pay-label');
  if (label) label.textContent = isActive ? '✓ الدفع مقسم - تعديل' : 'تقسيم الدفع على أكثر من طريقة';
}

function openSupplierSheet(container) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>اختر المورد</h3></div>
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input type="text" id="supplier-search" placeholder="ابحث عن مورد...">
    </div>
    <div class="list-item" style="cursor:pointer;" id="pick-no-supplier">
      <div class="avatar">🚚</div><div class="info"><div class="title">بدون مورد محدد</div></div>
    </div>
    <div id="supplier-results" class="customer-select-list"></div>
    <button class="btn btn-secondary btn-block" style="margin-top:10px;" id="add-new-supplier-btn">+ إضافة مورد جديد</button>
  `, { onOpen: (el) => el.querySelector('#supplier-search').focus() });

  overlay.querySelector('#pick-no-supplier').onclick = () => {
    purchaseState.supplier = null;
    closeSheet();
    renderPurchaseScreen(container);
  };

  const loadAndRender = async (q) => {
    const suppliers = await db.getSuppliers();
    const list = q ? suppliers.filter(s => fuzzyMatch(s.name, q) || (s.phone && s.phone.includes(q))) : suppliers;
    overlay.querySelector('#supplier-results').innerHTML = list.length ? list.slice(0, 30).map(s => `
      <div class="list-item" style="cursor:pointer;" data-pick="${s.id}">
        <div class="avatar">${escapeHtml(s.name[0])}</div>
        <div class="info"><div class="title">${escapeHtml(s.name)}</div><div class="subtitle">${s.phone || ''}</div></div>
      </div>`).join('') : emptyState('🚚', 'لا يوجد موردون مطابقون');
    overlay.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => {
      purchaseState.supplier = suppliers.find(x => x.id === el.dataset.pick);
      closeSheet();
      renderPurchaseScreen(container);
    });
  };
  loadAndRender('');
  overlay.querySelector('#supplier-search').oninput = debounce((e) => loadAndRender(e.target.value), 150);
  overlay.querySelector('#add-new-supplier-btn').onclick = () => { closeSheet(); openAddSupplierSheet(container); };
}

function openAddSupplierSheet(container) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>+ إضافة مورد</h3></div>
    <div class="form-group"><label>الاسم</label><input type="text" id="ns-name" placeholder="اسم المورد"></div>
    <div class="form-group"><label>رقم الهاتف (اختياري)</label><input type="tel" id="ns-phone" placeholder="05xxxxxxxx"></div>
    <button class="btn btn-primary btn-block" id="ns-save">حفظ واختيار</button>
  `, { onOpen: (el) => el.querySelector('#ns-name').focus() });

  overlay.querySelector('#ns-save').onclick = async () => {
    const name = overlay.querySelector('#ns-name').value.trim();
    if (!name) return toastError('أدخل اسم المورد');
    const btn = overlay.querySelector('#ns-save');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      const supplier = await db.addSupplier({ name, phone: overlay.querySelector('#ns-phone').value.trim() });
      purchaseState.supplier = supplier;
      closeSheet();
      toastSuccess('تم إضافة المورد');
      renderPurchaseScreen(container);
    } catch (err) {
      toastError('حدث خطأ أثناء حفظ المورد. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };
}

function openProductSheet(container) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>اختر منتجًا</h3></div>
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input type="text" id="product-search" placeholder="ابحث عن منتج...">
    </div>
    <div id="product-results" class="customer-select-list"></div>
    <button class="btn btn-secondary btn-block" style="margin-top:10px;" id="manual-product-btn">+ منتج غير موجود بالقائمة</button>
  `, { onOpen: (el) => el.querySelector('#product-search').focus() });

  const renderResults = (q) => {
    const list = container._allProducts.filter(p => fuzzyMatch(p.name, q));
    overlay.querySelector('#product-results').innerHTML = list.length ? list.map(p => `
      <div class="list-item" style="cursor:pointer;" data-pick="${p.id}">
        <div class="avatar">${productEmoji(p, container._categoryIcons)}</div>
        <div class="info"><div class="title">${escapeHtml(p.name)}</div><div class="subtitle">آخر سعر شراء: ${formatMoney(p.cost_price)} / ${p.unit}</div></div>
      </div>`).join('') : emptyState('🔍', 'لا توجد نتائج');
    overlay.querySelectorAll('[data-pick]').forEach(el => el.onclick = () => {
      const p = container._allProducts.find(x => x.id === el.dataset.pick);
      closeSheet();
      addItemFromProduct(container, p);
    });
  };
  renderResults('');
  overlay.querySelector('#product-search').oninput = debounce((e) => renderResults(e.target.value), 150);
  overlay.querySelector('#manual-product-btn').onclick = () => { closeSheet(); openManualProductSheet(container); };
}

function addItemFromProduct(container, product) {
  if (!product) return;
  purchaseState.items.push({
    product_id: product.id, product_name: product.name, quantity: '', unit: product.unit,
    purchase_price: fromCents(product.cost_price), update_cost_price: false
  });
  refreshItemsAndTotals(container);
}

function openManualProductSheet(container) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>منتج غير موجود بالقائمة</h3></div>
    <div class="form-group"><label>اسم المنتج</label><input type="text" id="mp-name" placeholder="اسم المنتج"></div>
    <div class="form-group"><label>الوحدة</label>
      <select id="mp-unit">${UNITS.map(u => `<option value="${u}">${u}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label>سعر الشراء</label><input type="number" id="mp-price" placeholder="0" step="0.5"></div>
    <button class="btn btn-primary btn-block" id="mp-add">إضافة</button>
  `, { onOpen: (el) => el.querySelector('#mp-name').focus() });

  overlay.querySelector('#mp-add').onclick = () => {
    const name = overlay.querySelector('#mp-name').value.trim();
    const price = parseFloat(overlay.querySelector('#mp-price').value);
    if (!name) return toastError('أدخل اسم المنتج');
    if (!price || price <= 0) return toastError('أدخل سعر شراء صحيح');
    closeSheet();
    purchaseState.items.push({
      product_id: null, product_name: name, quantity: '', unit: overlay.querySelector('#mp-unit').value,
      purchase_price: price, update_cost_price: false
    });
    refreshItemsAndTotals(container);
  };
}

async function completePurchase(container) {
  const btn = container.querySelector('#complete-purchase-btn');
  if (!purchaseState.items.length) return toastError('أضف منتجًا واحدًا على الأقل');
  if (purchaseState.items.some(it => !(parseFloat(it.quantity) > 0))) return toastError('أدخل الكمية أو الإجمالي لكل منتج قبل الحفظ');
  if (purchaseState.payMode === 'single') syncSingleMethodAmounts();
  const total = finalTotal();
  const { cash, transfer, credit } = purchaseState.split;
  if (Math.abs(cash + transfer + credit - total) > 1) return toastError('مجموع طرق الدفع لا يساوي إجمالي الفاتورة');
  if (credit > 0 && !purchaseState.supplier) { toastWarning('يجب اختيار مورد قبل تسجيل مبلغ آجل'); return openSupplierSheet(container); }

  setLoading(btn, true, 'جاري الحفظ...');
  try {
    const payload = {
      supplierId: purchaseState.supplier ? purchaseState.supplier.id : null,
      supplierName: purchaseState.supplier ? purchaseState.supplier.name : 'مورد بدون اسم',
      supplierInvoiceNumber: purchaseState.supplierInvoiceNumber,
      purchaseDate: purchaseState.purchaseDate ? new Date(purchaseState.purchaseDate).toISOString() : undefined,
      dueDate: credit > 0 && purchaseState.dueDate ? new Date(purchaseState.dueDate).toISOString() : null,
      items: purchaseState.items,
      discount: purchaseState.discount, extraCosts: purchaseState.extraCosts,
      paidCash: fromCents(cash), paidTransfer: fromCents(transfer), paidCredit: fromCents(credit),
      notes: container.querySelector('#p-notes').value.trim()
    };
    if (editingPurchaseId) {
      await db.updatePurchase(editingPurchaseId, payload);
      toastSuccess('تم حفظ التعديلات');
      window.location.hash = `#/purchase/${editingPurchaseId}`;
    } else {
      const { purchase } = await db.addPurchase(payload);
      toastSuccess('تم حفظ فاتورة الشراء');
      window.location.hash = `#/purchase/${purchase.id}`;
    }
  } catch (err) {
    console.error(err);
    toastError(err.message || 'حدث خطأ أثناء حفظ العملية. حاول مرة أخرى.');
    setLoading(btn, false);
  }
}

// ---------- عرض فاتورة الشراء ----------
export async function renderPurchaseInvoice(container, purchaseId) {
  const [purchase, settings, user] = await Promise.all([db.getPurchase(purchaseId), db.getSettings(), getCurrentUser()]);
  if (!purchase) { container.innerHTML = `<div class="card">فاتورة الشراء غير موجودة</div>`; return; }
  const canManage = canDelete(user);

  container.innerHTML = `
    <div class="card" id="invoice-card">
      <div style="text-align:center;margin-bottom:14px;">
        <div style="font-size:20px;font-weight:800;">${escapeHtml(settings.shopName)}</div>
        <div style="font-size:12.5px;color:var(--text-muted);">فاتورة شراء من مورد</div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--text-muted);margin-bottom:6px;">
        <span>${purchase.purchase_number}${purchase.supplier_invoice_number ? ` · فاتورة المورد: ${escapeHtml(purchase.supplier_invoice_number)}` : ''}</span>
        <span>${formatDateTime(purchase.created_at)}</span>
      </div>
      <div style="font-weight:700;margin-bottom:10px;">المورد: ${escapeHtml(purchase.supplier_name_snapshot || 'مورد بدون اسم')}</div>
      ${purchase.items.length ? `
      <table class="simple-table">
        <thead><tr><th>المنتج</th><th>الكمية</th><th>سعر الشراء</th><th>الإجمالي</th></tr></thead>
        <tbody>
          ${purchase.items.map(it => `<tr><td>${escapeHtml(it.product_name)}</td><td>${it.quantity} ${it.unit}</td><td>${formatMoney(it.purchase_price)}</td><td>${formatMoney(it.total_price)}</td></tr>`).join('')}
        </tbody>
      </table>
      ` : ''}
      <div class="totals-box">
        <div class="row"><span>إجمالي المنتجات</span><span>${formatMoney(purchase.subtotal)}</span></div>
        ${purchase.discount ? `<div class="row"><span>خصم</span><span>-${formatMoney(purchase.discount)}</span></div>` : ''}
        ${purchase.extra_costs ? `<div class="row"><span>تكاليف إضافية</span><span>+${formatMoney(purchase.extra_costs)}</span></div>` : ''}
        <div class="row grand"><span>الإجمالي النهائي</span><span>${formatMoney(purchase.total_amount)}</span></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;">
        ${purchase.paid_cash > 0 ? `<span class="badge cash">نقدي ${formatMoney(purchase.paid_cash)}</span>` : ''}
        ${purchase.paid_transfer > 0 ? `<span class="badge transfer">تحويل ${formatMoney(purchase.paid_transfer)}</span>` : ''}
        ${purchase.paid_credit > 0 ? `<span class="badge debt">آجل ${formatMoney(purchase.paid_credit)}</span>` : ''}
      </div>
      ${purchase.paid_credit > 0 ? `<div style="font-size:13px;color:var(--danger);font-weight:700;">المبلغ المتبقي المستحق للمورد من هذه الفاتورة: ${formatMoney(purchase.paid_credit)}</div>` : ''}
      ${purchase.due_date ? `<div style="font-size:12.5px;color:var(--text-muted);margin-top:4px;">تاريخ الاستحقاق: ${formatDateTime(purchase.due_date)}</div>` : ''}
      ${purchase.notes ? `<div style="margin-top:10px;font-size:13px;color:var(--text-muted);">ملاحظات: ${escapeHtml(purchase.notes)}</div>` : ''}
      <div class="print-only" style="text-align:center;margin-top:16px;font-size:12px;color:#888;">سجل داخلي لفاتورة شراء</div>
    </div>

    <div class="no-print" style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:10px;">
      <button class="btn btn-secondary" id="pinv-print">🖨️ طباعة</button>
      <button class="btn btn-secondary" id="pinv-share">📤 مشاركة</button>
    </div>
    ${canManage ? `
    <div class="no-print" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <button class="btn btn-outline" id="pinv-edit">تعديل الفاتورة</button>
      <button class="btn btn-danger" id="pinv-delete">حذف الفاتورة</button>
    </div>` : ''}
  `;
  renderAttachmentsSection(container, 'purchase', purchase.id);

  container.querySelector('#pinv-print').onclick = () => window.print();
  container.querySelector('#pinv-share').onclick = () => sharePurchaseInvoice(purchase, settings);

  if (canManage) {
    container.querySelector('#pinv-edit').onclick = () => window.location.hash = `#/purchase/edit/${purchase.id}`;
    container.querySelector('#pinv-delete').onclick = async () => {
      const ok = await confirmDialog({ title: 'حذف فاتورة الشراء', message: `سيتم حذف فاتورة ${purchase.purchase_number} وستتأثر أرصدة المورد والصندوق.` });
      if (!ok) return;
      try {
        await db.deletePurchase(purchase.id);
        toastSuccess('تم حذف فاتورة الشراء');
        window.location.hash = '#/purchases';
      } catch (err) {
        toastError('حدث خطأ أثناء حذف الفاتورة. حاول مرة أخرى.');
      }
    };
  }
}

async function sharePurchaseInvoice(purchase, settings) {
  const text = `${settings.shopName}\nفاتورة شراء ${purchase.purchase_number}\nالمورد: ${purchase.supplier_name_snapshot}\nالإجمالي: ${formatMoney(purchase.total_amount)}\nالتاريخ: ${formatDateTime(purchase.created_at)}`;
  if (navigator.share) {
    try { await navigator.share({ title: purchase.purchase_number, text }); }
    catch (e) { /* المستخدم أغلق نافذة المشاركة */ }
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    toastSuccess('تم نسخ تفاصيل الفاتورة');
  }
}

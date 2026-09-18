// شاشة بيع جديد - أهم شاشة في التطبيق، يجب أن تكون سريعة جدًا
import * as db from './database.js';
import { toastError, toastSuccess, toastWarning, openSheet, closeSheet, setLoading, emptyState } from './ui.js';
import { formatMoney, formatNumber, toCents, fromCents, escapeHtml, fuzzyMatch, debounce, uuid, UNITS } from './utils.js';

let saleState;
let editingSaleId = null;

function freshState() {
  return { customer: null, items: [], payMode: 'single', activeMethod: 'cash', split: { cash: 0, transfer: 0, debt: 0 }, transferRef: '', transferBank: '', notes: '' };
}

export async function renderNewSale(container) {
  editingSaleId = null;
  saleState = freshState();
  const [quickProducts, allProducts] = await Promise.all([db.getQuickProducts(10), db.getProducts({ activeOnly: true })]);
  container._allProducts = allProducts;
  container._quickProducts = quickProducts;
  renderSaleScreen(container);
}

export async function renderEditSale(container, saleId) {
  const sale = await db.getSale(saleId);
  if (!sale) return toastError('الفاتورة غير موجودة');
  editingSaleId = saleId;
  const [quickProducts, allProducts, customer] = await Promise.all([
    db.getQuickProducts(10), db.getProducts({ activeOnly: true }), db.getCustomer(sale.customer_id)
  ]);
  container._allProducts = allProducts;
  container._quickProducts = quickProducts;
  saleState = {
    customer: customer || null,
    items: sale.items.map(it => ({ product_id: it.product_id, product_name: it.product_name, quantity: it.quantity, unit: it.unit, cost_price: fromCents(it.cost_price), selling_price: fromCents(it.selling_price) })),
    payMode: 'split',
    activeMethod: 'cash',
    split: { cash: sale.paid_cash, transfer: sale.paid_transfer, debt: sale.paid_debt },
    transferRef: sale.transfer_reference || '', transferBank: sale.transfer_bank || '', notes: sale.notes || ''
  };
  renderSaleScreen(container);
  const btn = container.querySelector('#complete-sale-btn');
  if (btn) btn.textContent = 'حفظ التعديلات';
}

function renderSaleScreen(container) {
  const total = itemsTotal(saleState.items);
  container.innerHTML = `
    <div class="card" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;" id="customer-row">
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="avatar">${saleState.customer ? escapeHtml(saleState.customer.name[0]) : '💵'}</div>
        <div>
          <div style="font-weight:700;font-size:14.5px;">${saleState.customer ? escapeHtml(saleState.customer.name) : 'زبون نقدي'}</div>
          <div style="font-size:12px;color:var(--text-muted);">${saleState.customer ? 'اضغط لتغيير الزبون' : 'اضغط لاختيار زبون'}</div>
        </div>
      </div>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-muted)"><path d="M9 6l6 6-6 6"/></svg>
    </div>

    <div class="section-title" style="margin-top:14px;">منتجات سريعة</div>
    <div class="quick-grid" id="quick-products">
      ${container._quickProducts.map(p => `
        <div class="quick-btn" data-product-id="${p.id}">
          <span class="emoji">${categoryEmoji(p.category_id)}</span>${escapeHtml(p.name)}
        </div>`).join('')}
      <div class="quick-btn" id="search-product-btn"><span class="emoji">🔍</span>بحث / أخرى</div>
    </div>

    <div class="section-title">المنتجات المضافة (${saleState.items.length})</div>
    ${saleState.items.length ? `<div class="hint" style="margin-top:-6px;margin-bottom:8px;">💡 تقدر تكتب الوزن، أو تكتب مباشرة السعر الإجمالي من الميزان وبيحسب الوزن تلقائيًا</div>` : ''}
    <div class="card" id="items-card" style="padding:6px 10px;">
      ${renderItemsList()}
    </div>

    <div class="totals-box">
      <div class="row grand"><span>الإجمالي</span><span>${formatMoney(total)}</span></div>
    </div>

    <div class="section-title">طريقة الدفع</div>
    <div class="pay-methods" id="pay-methods">
      <div class="pay-method-btn ${saleState.payMode==='single' && saleState.activeMethod==='cash' ? 'active':''}" data-method="cash"><span class="emoji">💵</span>نقدي</div>
      <div class="pay-method-btn ${saleState.payMode==='single' && saleState.activeMethod==='transfer' ? 'active':''}" data-method="transfer"><span class="emoji">📱</span>تحويل</div>
      <div class="pay-method-btn ${saleState.payMode==='single' && saleState.activeMethod==='debt' ? 'active':''}" data-method="debt"><span class="emoji">📝</span>دين</div>
    </div>
    <button class="link-btn" id="split-pay-btn">${saleState.payMode === 'split' ? '✓ الدفع مقسم - تعديل' : 'تقسيم الدفع بين أكثر من طريقة'}</button>

    <div class="form-group" style="margin-top:14px;">
      <label>ملاحظات (اختياري)</label>
      <textarea id="sale-notes" placeholder="أي ملاحظات على الفاتورة">${escapeHtml(saleState.notes || '')}</textarea>
    </div>

    <button class="btn btn-primary btn-block" id="complete-sale-btn" style="padding:16px;font-size:16px;">إتمام البيع</button>
  `;
  bindSaleScreen(container);
}

function categoryEmoji(catId) {
  const map = { 'cat-meat': '🥩', 'cat-chicken': '🍗', 'cat-vegetables': '🥬', 'cat-fruits': '🍎', 'cat-groceries': '🧂', 'cat-other': '📦' };
  return map[catId] || '📦';
}

function itemsTotal(items) {
  return items.reduce((s, it) => s + Math.round(toCents(it.selling_price) * it.quantity), 0);
}

function renderItemsList() {
  if (!saleState.items.length) return emptyState('🛒', 'لم تُضف منتجات بعد', 'اختر منتجًا من الأعلى للبدء');
  return saleState.items.map((it, idx) => `
    <div class="sale-item-row" data-idx="${idx}" style="flex-direction:column;align-items:stretch;gap:8px;">
      <div style="display:flex;align-items:center;">
        <div class="prod-name" style="flex:1;">${escapeHtml(it.product_name)}</div>
        <button class="remove-btn" data-remove="${idx}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
        </button>
      </div>
      <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;">
        <input type="number" inputmode="decimal" class="item-qty" data-idx="${idx}" value="${it.quantity}" step="0.1" min="0.01" style="width:56px;padding:7px 6px;font-size:13px;" title="الكمية">
        <span class="prod-meta">${it.unit} ×</span>
        <input type="number" inputmode="decimal" class="item-price" data-idx="${idx}" value="${fromCents(toCents(it.selling_price))}" step="0.5" min="0" style="width:60px;padding:7px 6px;font-size:13px;" title="سعر الكيلو">
        <span class="prod-meta">₪ =</span>
        <input type="number" inputmode="decimal" class="item-total" data-idx="${idx}" value="${fromCents(Math.round(toCents(it.selling_price) * it.quantity))}" step="0.5" min="0" style="width:68px;padding:7px 6px;font-size:13px;font-weight:700;color:var(--primary-dark);" title="الإجمالي من الميزان">
        <span class="prod-meta">₪</span>
      </div>
    </div>`).join('');
}

function refreshItemsAndTotals(container) {
  container.querySelector('#items-card').innerHTML = renderItemsList();
  updateItemsSectionTitle(container);
  const total = itemsTotal(saleState.items);
  container.querySelector('.totals-box .grand span:last-child').textContent = formatMoney(total);
  bindItemInputs(container);
  syncSingleMethodAmounts();
}

function bindItemInputs(container) {
  container.querySelectorAll('.item-qty').forEach(inp => inp.oninput = () => {
    const idx = +inp.dataset.idx;
    saleState.items[idx].quantity = parseFloat(inp.value) || 0;
    updateRowTotal(container, idx);
  });
  container.querySelectorAll('.item-price').forEach(inp => inp.oninput = () => {
    const idx = +inp.dataset.idx;
    saleState.items[idx].selling_price = parseFloat(inp.value) || 0;
    updateRowTotal(container, idx);
  });
  container.querySelectorAll('.item-total').forEach(inp => inp.oninput = () => {
    const idx = +inp.dataset.idx;
    updateRowQuantityFromTotal(container, idx, parseFloat(inp.value) || 0);
  });
  container.querySelectorAll('[data-remove]').forEach(btn => btn.onclick = () => {
    saleState.items.splice(+btn.dataset.remove, 1);
    refreshItemsAndTotals(container);
  });
}

// عند تعديل الكمية أو السعر: نعيد حساب الإجمالي (Total = Qty × Price)
function updateRowTotal(container, idx) {
  const row = container.querySelector(`.sale-item-row[data-idx="${idx}"]`);
  const it = saleState.items[idx];
  const totalCents = Math.round(toCents(it.selling_price) * it.quantity);
  row.querySelector('.item-total').value = fromCents(totalCents);
  updateGrandTotal(container);
}

// عند تعديل الإجمالي (السعر من الميزان): نعيد حساب الكمية بالعكس = Total ÷ Price
function updateRowQuantityFromTotal(container, idx, totalValue) {
  const row = container.querySelector(`.sale-item-row[data-idx="${idx}"]`);
  const it = saleState.items[idx];
  if (it.selling_price > 0) {
    it.quantity = Math.round((totalValue / it.selling_price) * 1000) / 1000;
    row.querySelector('.item-qty').value = it.quantity;
  }
  updateGrandTotal(container);
}

function updateGrandTotal(container) {
  const total = itemsTotal(saleState.items);
  container.querySelector('.totals-box .grand span:last-child').textContent = formatMoney(total);
  syncSingleMethodAmounts();
}

function syncSingleMethodAmounts() {
  if (saleState.payMode !== 'single') return;
  const total = itemsTotal(saleState.items);
  saleState.split = { cash: 0, transfer: 0, debt: 0 };
  saleState.split[saleState.activeMethod] = total;
}

function bindSaleScreen(container) {
  bindItemInputs(container);
  container.querySelector('#customer-row').onclick = () => openCustomerSheet(container);
  container.querySelector('#search-product-btn').onclick = () => openProductSheet(container);
  container.querySelectorAll('[data-product-id]').forEach(el => el.onclick = () => {
    const p = container._quickProducts.find(x => x.id === el.dataset.productId) || container._allProducts.find(x => x.id === el.dataset.productId);
    addItemFromProduct(container, p);
  });

  container.querySelectorAll('.pay-method-btn').forEach(btn => btn.onclick = () => {
    saleState.payMode = 'single';
    saleState.activeMethod = btn.dataset.method;
    syncSingleMethodAmounts();
    container.querySelectorAll('.pay-method-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    container.querySelector('#split-pay-btn').textContent = 'تقسيم الدفع بين أكثر من طريقة';
    if (btn.dataset.method === 'debt') maybeCaptureTransferOrRequireCustomer(container);
  });

  container.querySelector('#split-pay-btn').onclick = () => openSplitPaymentSheet(container);
  container.querySelector('#complete-sale-btn').onclick = () => completeSale(container);
}

function addItemFromProduct(container, product) {
  if (!product) return;
  saleState.items.push({
    product_id: product.id, product_name: product.name, quantity: 1, unit: product.unit,
    cost_price: fromCents(product.cost_price), selling_price: fromCents(product.selling_price)
  });
  refreshItemsAndTotals(container);
}

function updateItemsSectionTitle(container) {
  const titles = container.querySelectorAll('.section-title');
  if (titles[1]) titles[1].childNodes[0].textContent = `المنتجات المضافة (${saleState.items.length})`;
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
        <div class="avatar">${categoryEmoji(p.category_id)}</div>
        <div class="info"><div class="title">${escapeHtml(p.name)}</div><div class="subtitle">${formatMoney(p.selling_price)} / ${p.unit}</div></div>
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

function openManualProductSheet(container) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>منتج غير موجود بالقائمة</h3></div>
    <div class="form-group"><label>اسم المنتج</label><input type="text" id="mp-name" placeholder="اسم المنتج"></div>
    <div class="form-group"><label>الوحدة</label>
      <select id="mp-unit">${UNITS.map(u => `<option value="${u}">${u}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label>سعر الشراء (اختياري)</label><input type="number" id="mp-cost" placeholder="0" step="0.5"></div>
    <div class="form-group"><label>سعر البيع</label><input type="number" id="mp-price" placeholder="0" step="0.5"></div>
    <button class="btn btn-primary btn-block" id="mp-add">إضافة</button>
  `, { onOpen: (el) => el.querySelector('#mp-name').focus() });

  overlay.querySelector('#mp-add').onclick = () => {
    const name = overlay.querySelector('#mp-name').value.trim();
    const price = parseFloat(overlay.querySelector('#mp-price').value);
    if (!name) return toastError('أدخل اسم المنتج');
    if (!price || price <= 0) return toastError('أدخل سعر بيع صحيح');
    const cost = parseFloat(overlay.querySelector('#mp-cost').value) || 0;
    closeSheet();
    saleState.items.push({
      product_id: null, product_name: name, quantity: 1, unit: overlay.querySelector('#mp-unit').value,
      cost_price: cost, selling_price: price
    });
    refreshItemsAndTotals(container);
  };
}

function openCustomerSheet(container) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>اختر الزبون</h3></div>
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input type="text" id="customer-search" placeholder="ابحث عن زبون...">
    </div>
    <div class="list-item" style="cursor:pointer;" id="pick-cash-customer">
      <div class="avatar">💵</div><div class="info"><div class="title">زبون نقدي</div></div>
    </div>
    <div id="customer-results" class="customer-select-list"></div>
    <button class="btn btn-secondary btn-block" style="margin-top:10px;" id="add-new-customer-btn">+ إضافة زبون جديد</button>
  `, { onOpen: (el) => el.querySelector('#customer-search').focus() });

  overlay.querySelector('#pick-cash-customer').onclick = () => {
    saleState.customer = null;
    closeSheet();
    renderSaleScreen(container);
  };

  const loadAndRender = async (q) => {
    const customers = await db.getCustomers();
    const list = q ? customers.filter(c => fuzzyMatch(c.name, q) || (c.phone && c.phone.includes(q))) : customers;
    overlay.querySelector('#customer-results').innerHTML = list.length ? list.slice(0, 30).map(c => `
      <div class="list-item" style="cursor:pointer;" data-pick="${c.id}">
        <div class="avatar">${escapeHtml(c.name[0])}</div>
        <div class="info"><div class="title">${escapeHtml(c.name)}</div><div class="subtitle">${c.phone || ''}</div></div>
      </div>`).join('') : emptyState('👤', 'لا يوجد زبائن مطابقون');
    overlay.querySelectorAll('[data-pick]').forEach(el => el.onclick = async () => {
      const c = customers.find(x => x.id === el.dataset.pick);
      saleState.customer = c;
      closeSheet();
      renderSaleScreen(container);
    });
  };
  loadAndRender('');
  overlay.querySelector('#customer-search').oninput = debounce((e) => loadAndRender(e.target.value), 150);
  overlay.querySelector('#add-new-customer-btn').onclick = () => { closeSheet(); openAddCustomerSheet(container); };
}

function openAddCustomerSheet(container) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>+ إضافة زبون</h3></div>
    <div class="form-group"><label>الاسم</label><input type="text" id="nc-name" placeholder="اسم الزبون"></div>
    <div class="form-group"><label>رقم الهاتف (اختياري)</label><input type="tel" id="nc-phone" placeholder="05xxxxxxxx"></div>
    <div class="form-group"><label>ملاحظات (اختياري)</label><textarea id="nc-notes"></textarea></div>
    <button class="btn btn-primary btn-block" id="nc-save">حفظ واختيار</button>
  `, { onOpen: (el) => el.querySelector('#nc-name').focus() });

  overlay.querySelector('#nc-save').onclick = async () => {
    const name = overlay.querySelector('#nc-name').value.trim();
    if (!name) return toastError('أدخل اسم الزبون');
    const btn = overlay.querySelector('#nc-save');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      const customer = await db.addCustomer({ name, phone: overlay.querySelector('#nc-phone').value.trim(), notes: overlay.querySelector('#nc-notes').value.trim() });
      saleState.customer = customer;
      closeSheet();
      toastSuccess('تم إضافة الزبون');
      renderSaleScreen(container);
    } catch (err) {
      toastError('حدث خطأ أثناء حفظ الزبون. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };
}

function maybeCaptureTransferOrRequireCustomer(container) {
  if (!saleState.customer) {
    toastWarning('يجب اختيار زبون قبل تسجيل الدين');
    openCustomerSheet(container);
  }
}

function openSplitPaymentSheet(container) {
  const total = itemsTotal(saleState.items);
  const s = saleState.split;
  const overlay = openSheet(`
    <div class="sheet-header"><h3>تقسيم الدفع</h3></div>
    <div class="totals-box" style="margin-top:0;"><div class="row grand"><span>إجمالي الفاتورة</span><span>${formatMoney(total)}</span></div></div>
    <div class="form-group"><label>💵 نقدي</label><input type="number" id="sp-cash" value="${fromCents(s.cash)}" step="0.5" min="0"></div>
    <div class="form-group"><label>📱 تحويل</label><input type="number" id="sp-transfer" value="${fromCents(s.transfer)}" step="0.5" min="0"></div>
    <div class="form-group"><label>📝 دين</label><input type="number" id="sp-debt" value="${fromCents(s.debt)}" step="0.5" min="0"></div>
    <div id="sp-remaining" style="font-size:13px;font-weight:700;margin-bottom:12px;"></div>
    <button class="btn btn-primary btn-block" id="sp-save">تأكيد التقسيم</button>
  `);

  const updateRemaining = () => {
    const cash = toCents(overlay.querySelector('#sp-cash').value || 0);
    const transfer = toCents(overlay.querySelector('#sp-transfer').value || 0);
    const debt = toCents(overlay.querySelector('#sp-debt').value || 0);
    const remaining = total - (cash + transfer + debt);
    const el = overlay.querySelector('#sp-remaining');
    el.textContent = remaining === 0 ? '✅ المبلغ مطابق للإجمالي' : `المتبقي: ${formatMoney(remaining)}`;
    el.style.color = remaining === 0 ? 'var(--success)' : 'var(--danger)';
    return { cash, transfer, debt, remaining };
  };
  ['sp-cash', 'sp-transfer', 'sp-debt'].forEach(id => overlay.querySelector(`#${id}`).oninput = updateRemaining);
  updateRemaining();

  overlay.querySelector('#sp-save').onclick = () => {
    const { cash, transfer, debt, remaining } = updateRemaining();
    if (remaining !== 0) return toastError('مجموع طرق الدفع يجب أن يساوي إجمالي الفاتورة');
    if (debt > 0 && !saleState.customer) { toastWarning('يجب اختيار زبون قبل تسجيل الدين'); return openCustomerSheet(container); }
    saleState.payMode = 'split';
    saleState.split = { cash, transfer, debt };
    closeSheet();
    container.querySelector('#split-pay-btn').textContent = '✓ الدفع مقسم - تعديل';
    container.querySelectorAll('.pay-method-btn').forEach(b => b.classList.remove('active'));
  };
}

async function completeSale(container) {
  const btn = container.querySelector('#complete-sale-btn');
  if (!saleState.items.length) return toastError('أضف منتجًا واحدًا على الأقل');
  const total = itemsTotal(saleState.items);
  if (saleState.payMode === 'single') syncSingleMethodAmounts();
  const { cash, transfer, debt } = saleState.split;
  if (Math.abs(cash + transfer + debt - total) > 1) return toastError('مجموع طرق الدفع لا يساوي إجمالي الفاتورة');
  if (debt > 0 && !saleState.customer) { toastWarning('يجب اختيار زبون قبل تسجيل الدين'); return openCustomerSheet(container); }

  setLoading(btn, true, 'جاري الحفظ...');
  try {
    const payload = {
      customerId: saleState.customer ? saleState.customer.id : null,
      customerName: saleState.customer ? saleState.customer.name : 'زبون نقدي',
      items: saleState.items,
      paidCash: fromCents(cash), paidTransfer: fromCents(transfer), paidDebt: fromCents(debt),
      transferReference: saleState.transferRef, transferBank: saleState.transferBank,
      notes: container.querySelector('#sale-notes').value.trim()
    };
    if (editingSaleId) {
      await db.updateSale(editingSaleId, payload);
      toastSuccess('تم حفظ التعديلات');
      window.location.hash = `#/invoice/${editingSaleId}`;
    } else {
      const { sale } = await db.createSale(payload);
      toastSuccess('تم حفظ عملية البيع');
      window.location.hash = `#/invoice/${sale.id}`;
    }
  } catch (err) {
    console.error(err);
    toastError(err.message || 'حدث خطأ أثناء حفظ العملية. حاول مرة أخرى.');
    setLoading(btn, false);
  }
}

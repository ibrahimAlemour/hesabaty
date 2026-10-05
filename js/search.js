// بحث عام موحّد: يبحث دفعة واحدة بالزبائن والموردين والمنتجات وفواتير البيع والشراء
import * as db from './database.js';
import { formatMoney, escapeHtml, fuzzyMatch, debounce } from './utils.js';
import { emptyState } from './ui.js';
import { setProductSearchQuery } from './products.js';

let currentQuery = '';
const RESULTS_PER_SECTION = 15;

// الهيكل الثابت (مربع البحث) يُبنى مرة واحدة فقط؛ كل كتابة تُحدّث فقط #global-search-results
// لمنع فقدان الأحرف أثناء الكتابة السريعة (نفس نمط الإصلاح المطبّق بباقي شاشات البحث بالتطبيق)
export async function renderGlobalSearch(container) {
  container.innerHTML = `
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input type="text" id="global-search-input" placeholder="ابحث عن زبون، مورد، منتج أو فاتورة..." value="${escapeHtml(currentQuery)}">
    </div>
    <div id="global-search-results"></div>
  `;

  const input = container.querySelector('#global-search-input');
  const resultsEl = container.querySelector('#global-search-results');

  const renderResults = async (q) => {
    const query = q.trim();
    if (!query) {
      resultsEl.innerHTML = emptyState('🔍', 'اكتب كلمة للبحث بكل أقسام التطبيق دفعة واحدة');
      return;
    }
    const [customers, suppliers, products, sales, purchases] = await Promise.all([
      db.getCustomers(), db.getSuppliers(), db.getProducts(), db.getSales(), db.getPurchases()
    ]);

    const matchedCustomers = customers
      .filter(c => fuzzyMatch(c.name, query) || (c.phone && c.phone.includes(query)))
      .slice(0, RESULTS_PER_SECTION);
    const matchedSuppliers = suppliers
      .filter(s => fuzzyMatch(s.name, query) || (s.phone && s.phone.includes(query)))
      .slice(0, RESULTS_PER_SECTION);
    const matchedProducts = products
      .filter(p => fuzzyMatch(p.name, query))
      .slice(0, RESULTS_PER_SECTION);
    const matchedSales = sales
      .filter(s => String(s.invoice_number || '').includes(query) || fuzzyMatch(s.customer_name_snapshot || '', query))
      .slice(0, RESULTS_PER_SECTION);
    const matchedPurchases = purchases
      .filter(p => String(p.supplier_invoice_number || '').includes(query) || fuzzyMatch(p.supplier_name_snapshot || '', query))
      .slice(0, RESULTS_PER_SECTION);

    const sections = [];
    if (matchedCustomers.length) sections.push(sectionHtml('👥 الزبائن', matchedCustomers.map(c =>
      resultRow('👤', c.name, c.phone || 'بدون رقم جوال', `#/customers/${c.id}`))));
    if (matchedSuppliers.length) sections.push(sectionHtml('🚚 الموردون', matchedSuppliers.map(s =>
      resultRow('🚚', s.name, s.phone || 'بدون رقم جوال', `#/suppliers/${s.id}`))));
    if (matchedProducts.length) sections.push(sectionHtml('📦 المنتجات', matchedProducts.map(p =>
      resultRow(p.icon || '📦', p.name, `${p.unit} - بيع ${formatMoney(p.selling_price)}`, null, p.id))));
    if (matchedSales.length) sections.push(sectionHtml('🧾 فواتير البيع', matchedSales.map(s =>
      resultRow('🧾', `فاتورة ${s.invoice_number}`, `${escapeHtml(s.customer_name_snapshot || '')} - ${formatMoney(s.total_amount)}`, `#/invoice/${s.id}`))));
    if (matchedPurchases.length) sections.push(sectionHtml('📥 فواتير الشراء', matchedPurchases.map(p =>
      resultRow('📥', `فاتورة ${p.supplier_invoice_number || 'بدون رقم'}`, `${escapeHtml(p.supplier_name_snapshot || '')} - ${formatMoney(p.total_amount)}`, `#/purchase/${p.id}`))));

    resultsEl.innerHTML = sections.length ? sections.join('') : emptyState('🔍', `لا توجد نتائج لـ "${escapeHtml(query)}"`);

    resultsEl.querySelectorAll('[data-nav]').forEach(el => el.onclick = () => { window.location.hash = el.dataset.nav; });
    resultsEl.querySelectorAll('[data-product]').forEach(el => el.onclick = () => {
      setProductSearchQuery(products.find(p => p.id === el.dataset.product)?.name || '');
      window.location.hash = '#/products';
    });
  };

  renderResults(currentQuery);
  input.oninput = debounce((e) => { currentQuery = e.target.value; renderResults(currentQuery); }, 200);
}

function sectionHtml(title, rowsHtml) {
  return `<div class="section-title">${title}</div><div class="card" style="padding:6px 10px;margin-bottom:14px;">${rowsHtml.join('')}</div>`;
}

// نتيجة منتج بدون صفحة تفاصيل خاصة بها بكل التطبيق (التعديل يتم من شيت بقائمة المنتجات نفسها)،
// فنستخدم data-product بدل data-nav لنملأ خانة البحث بشاشة المنتجات باسمه تلقائيًا بدل مجرد فتح القائمة فاضية
function resultRow(icon, title, subtitle, navHash, productId) {
  const attr = productId ? `data-product="${productId}"` : `data-nav="${navHash}"`;
  return `
    <div class="list-item" style="cursor:pointer;" ${attr}>
      <div class="avatar">${icon}</div>
      <div class="info">
        <div class="title">${escapeHtml(title)}</div>
        <div class="subtitle">${subtitle}</div>
      </div>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-muted)"><path d="M9 6l6 6-6 6"/></svg>
    </div>`;
}

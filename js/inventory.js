// المخزون: كم بيع من كل منتج موجود بالمحل اليوم (بالوزن أو بالقطعة حسب وحدة كل منتج)
import * as db from './database.js';
import { formatNumber, escapeHtml, fuzzyMatch, debounce, todayLabel } from './utils.js';
import { emptyState } from './ui.js';

let currentCategory = 'all';
let currentQuery = '';

export async function renderInventory(container) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const [items, categories] = await Promise.all([db.getInventorySoldToday(), db.getCategories()]);
  container._categories = categories;
  renderList(container, items);
}

function renderList(container, items) {
  const categories = container._categories;
  let filtered = items;
  if (currentCategory !== 'all') filtered = filtered.filter(i => i.category_id === currentCategory);
  if (currentQuery) filtered = filtered.filter(i => fuzzyMatch(i.name, currentQuery));

  const soldCount = items.filter(i => i.soldToday > 0).length;

  container.innerHTML = `
    <div style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">
      مبيعات اليوم لكل صنف - ${todayLabel()} - <b style="color:var(--primary-dark);">${soldCount}</b> من ${items.length} صنف تم بيعه اليوم
    </div>
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input type="text" id="inv-search" placeholder="ابحث عن منتج..." value="${escapeHtml(currentQuery)}">
    </div>
    <div class="tabs">
      <button class="tab-btn ${currentCategory === 'all' ? 'active' : ''}" data-cat="all">الكل</button>
      ${categories.map(c => `<button class="tab-btn ${currentCategory === c.id ? 'active' : ''}" data-cat="${c.id}">${c.icon} ${c.name}</button>`).join('')}
    </div>
    <div class="card" style="padding:6px 10px;">
      ${filtered.length ? filtered.map(i => itemRow(i, categories)).join('') : emptyState('📦', 'لا توجد منتجات مطابقة')}
    </div>
  `;

  container.querySelector('#inv-search').oninput = debounce((e) => { currentQuery = e.target.value; renderList(container, items); }, 150);
  container.querySelectorAll('[data-cat]').forEach(btn => btn.onclick = () => { currentCategory = btn.dataset.cat; renderList(container, items); });
}

function itemRow(item, categories) {
  const cat = categories.find(c => c.id === item.category_id);
  const sold = item.soldToday > 0;
  return `
    <div class="list-item">
      <div class="avatar">${cat ? cat.icon : '📦'}</div>
      <div class="info">
        <div class="title">${escapeHtml(item.name)}</div>
        <div class="subtitle">${item.unit}</div>
      </div>
      <div style="text-align:left;">
        <div class="amount" style="${sold ? 'color:var(--primary-dark);' : 'color:var(--text-muted);'}">${formatNumber(item.soldToday)} ${item.unit}</div>
        <div class="meta">بيع اليوم</div>
      </div>
    </div>`;
}

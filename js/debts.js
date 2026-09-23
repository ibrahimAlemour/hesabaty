// صفحة الديون: نظرة عامة على كل الزبائن الذين عليهم رصيد مستحق
import * as db from './database.js';
import { openRecordPaymentSheet } from './customers.js';
import { formatMoney, formatDate, escapeHtml, fuzzyMatch, debounce } from './utils.js';
import { emptyState } from './ui.js';

let currentCycle = 'all';

export async function renderDebts(container) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const all = await db.getCustomersWithBalance();
  const debtors = all.filter(c => c.balance > 0).sort((a, b) => b.balance - a.balance);
  const total = debtors.reduce((s, c) => s + c.balance, 0);
  currentCycle = 'all';
  renderList(container, debtors, total, '');
}

function renderList(container, debtors, total, query) {
  let filtered = query ? debtors.filter(c => fuzzyMatch(c.name, query)) : debtors;
  if (currentCycle !== 'all') filtered = filtered.filter(c => (c.payment_cycle || 'none') === currentCycle);

  container.innerHTML = `
    <div class="card" style="text-align:center;">
      <div class="stat-label" style="justify-content:center;">إجمالي الديون المستحقة</div>
      <div class="stat-value" style="color:var(--danger);font-size:26px;">${formatMoney(total)}</div>
      <div style="font-size:12.5px;color:var(--text-muted);margin-top:4px;">${debtors.length} زبون عليهم رصيد</div>
    </div>
    <div class="search-box">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input type="text" id="debt-search" placeholder="ابحث عن زبون..." value="${escapeHtml(query)}">
    </div>
    <div class="tabs">
      <button class="tab-btn ${currentCycle === 'all' ? 'active' : ''}" data-cycle="all">الكل</button>
      <button class="tab-btn ${currentCycle === 'weekly' ? 'active' : ''}" data-cycle="weekly">🗓️ أسبوعي</button>
      <button class="tab-btn ${currentCycle === 'monthly' ? 'active' : ''}" data-cycle="monthly">🗓️ شهري</button>
      <button class="tab-btn ${currentCycle === 'none' ? 'active' : ''}" data-cycle="none">بدون تحديد</button>
    </div>
    <div class="card" style="padding:6px 10px;">
      ${filtered.length ? filtered.map(debtorRow).join('') : emptyState('✅', 'لا توجد ديون مستحقة')}
    </div>
  `;
  container.querySelector('#debt-search').oninput = debounce((e) => renderList(container, debtors, total, e.target.value), 150);
  container.querySelectorAll('[data-cycle]').forEach(btn => btn.onclick = () => { currentCycle = btn.dataset.cycle; renderList(container, debtors, total, container.querySelector('#debt-search').value); });
  container.querySelectorAll('[data-open]').forEach(el => el.onclick = () => window.location.hash = `#/customers/${el.dataset.open}`);
  container.querySelectorAll('[data-pay]').forEach(el => el.onclick = (ev) => {
    ev.stopPropagation();
    const c = debtors.find(x => x.id === el.dataset.pay);
    openRecordPaymentSheet(c, c.balance, () => renderDebts(container));
  });
}

function debtorRow(c) {
  const cycle = c.payment_cycle && db.PAYMENT_CYCLES[c.payment_cycle];
  const overdue = c.dueDate && new Date(c.dueDate) < new Date();
  return `
    <div class="list-item" style="cursor:pointer;" data-open="${c.id}">
      <div class="avatar">${escapeHtml(c.name[0])}</div>
      <div class="info">
        <div class="title">${escapeHtml(c.name)} ${cycle ? `<span class="badge" style="background:var(--blue-light);color:var(--blue);margin-right:6px;">🗓️ ${cycle.label}</span>` : ''}</div>
        <div class="subtitle">${c.phone || ''}</div>
        ${c.dueDate ? `<div class="meta" style="${overdue ? 'color:var(--danger);font-weight:700;' : ''}">${overdue ? 'تجاوز موعد السداد' : 'السداد المتوقع'}: ${formatDate(c.dueDate)}</div>` : ''}
      </div>
      <div style="text-align:left;display:flex;flex-direction:column;align-items:flex-end;gap:6px;">
        <div class="amount debt">${formatMoney(c.balance)}</div>
        <button class="btn btn-sm btn-primary" data-pay="${c.id}">تحصيل</button>
      </div>
    </div>`;
}

// صفحة التحويلات: كل المبالغ المدفوعة عن طريق التحويل (من المبيعات أو تحصيل الديون)
import * as db from './database.js';
import { formatMoney, formatDateTime, escapeHtml, dateRangeFor } from './utils.js';
import { emptyState } from './ui.js';

let currentFilter = 'today';

export async function renderTransfers(container) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  await renderForFilter(container, currentFilter);
}

async function renderForFilter(container, filter) {
  currentFilter = filter;
  const range = filter === 'all' ? {} : dateRangeFor(filter === 'week' ? 'last7' : filter === 'month' ? 'month' : 'today');
  let transfers = await db.getTransfers(range);

  // إكمال اسم الزبون لعمليات الدفعات المستقلة
  const missingNames = transfers.filter(t => t.source === 'payment' && !t.customerName);
  const uniqueIds = [...new Set(missingNames.map(t => t.customerId))];
  const nameMap = {};
  for (const id of uniqueIds) { const c = await db.getCustomer(id); nameMap[id] = c ? c.name : 'زبون'; }
  transfers = transfers.map(t => t.source === 'payment' ? { ...t, customerName: nameMap[t.customerId] || 'زبون' } : t);

  const total = transfers.reduce((s, t) => s + t.amount, 0);

  container.innerHTML = `
    <div class="card" style="text-align:center;">
      <div class="stat-label" style="justify-content:center;">إجمالي التحويلات</div>
      <div class="stat-value" style="color:var(--blue);font-size:26px;">${formatMoney(total)}</div>
    </div>
    <div class="tabs">
      ${[['today','اليوم'],['week','هذا الأسبوع'],['month','هذا الشهر'],['all','الكل']].map(([k,l]) => `<button class="tab-btn ${filter===k?'active':''}" data-filter="${k}">${l}</button>`).join('')}
    </div>
    <div class="card" style="padding:6px 10px;">
      ${transfers.length ? transfers.map(transferRow).join('') : emptyState('📱', 'لا توجد تحويلات في هذه الفترة')}
    </div>
  `;
  container.querySelectorAll('[data-filter]').forEach(btn => btn.onclick = () => renderForFilter(container, btn.dataset.filter));
}

function transferRow(t) {
  return `
    <div class="list-item">
      <div class="avatar" style="background:var(--blue-light);color:var(--blue);">📱</div>
      <div class="info">
        <div class="title">${escapeHtml(t.customerName || 'زبون بدون اسم')}</div>
        <div class="subtitle">${t.bank ? escapeHtml(t.bank) + ' - ' : ''}${t.referenceNumber ? 'رقم: ' + escapeHtml(t.referenceNumber) : (t.notes ? escapeHtml(t.notes) : '')}</div>
      </div>
      <div style="text-align:left;">
        <div class="amount transfer">${formatMoney(t.amount)}</div>
        <div class="meta">${formatDateTime(t.date)}</div>
      </div>
    </div>`;
}

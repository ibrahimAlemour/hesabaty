// صفحة التحويلات: كل المبالغ المدفوعة عن طريق التحويل (من المبيعات أو تحصيل الديون)
import * as db from './database.js';
import { formatMoney, formatDateTime, escapeHtml, dateRangeFor } from './utils.js';
import { emptyState, toastSuccess, toastError, confirmDialog } from './ui.js';

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
  bindRowActions(container, filter);
}

// تعديل تحويل مصدره فاتورة بيع يفتح شاشة تعديل الفاتورة الكاملة (قد تحتوي أصنافًا ودفعات مقسّمة، لا حقل
// منفصل يُعدَّل وحده) - تمامًا كزر "تعديل الفاتورة" بشاشة الفاتورة نفسها. تحويل مصدره دفعة تحصيل دين مستقلة
// لا توجد له شاشة تعديل بالتطبيق كله حاليًا (فقط إضافة/حذف) فنكتفي بخيار الحذف له، للاتساق مع بقية الشاشات
function bindRowActions(container, filter) {
  container.querySelectorAll('[data-edit-transfer]').forEach(el => el.onclick = (ev) => {
    ev.stopPropagation();
    window.location.hash = `#/sale/edit/${el.dataset.editTransfer}`;
  });
  container.querySelectorAll('[data-delete-transfer]').forEach(el => el.onclick = async (ev) => {
    ev.stopPropagation();
    const [source, id] = el.dataset.deleteTransfer.split(':');
    if (source === 'sale') {
      const ok = await confirmDialog({ title: 'حذف الفاتورة', message: 'سيتم حذف الفاتورة كاملة بكل بنودها (ليس التحويل فقط)، وستتأثر أرصدة الزبون والصندوق. لا يمكن التراجع عن هذا الإجراء.' });
      if (!ok) return;
      try {
        await db.deleteSale(id);
        toastSuccess('تم حذف الفاتورة');
        renderForFilter(container, filter);
      } catch (err) { toastError(err.message || 'حدث خطأ أثناء الحذف'); }
      return;
    }
    const ok = await confirmDialog({ title: 'حذف الدفعة', message: 'سيتم حذف هذه الدفعة وستتأثر أرصدة الزبون والصندوق.' });
    if (!ok) return;
    try {
      await db.deletePayment(id);
      toastSuccess('تم حذف الدفعة');
      renderForFilter(container, filter);
    } catch (err) { toastError(err.message || 'حدث خطأ أثناء الحذف'); }
  });
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
      <div class="row-actions">
        ${t.source === 'sale' ? `<button class="edit-btn" data-edit-transfer="${t.id}" title="تعديل الفاتورة">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>
        </button>` : ''}
        <button class="remove-btn" data-delete-transfer="${t.source}:${t.id}" title="حذف">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
        </button>
      </div>
    </div>`;
}

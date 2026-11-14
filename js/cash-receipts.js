// شاشة المقبوضات النقدية: كل المبالغ المقبوضة نقدًا (من المبيعات أو تحصيل الديون) - مرآة شاشة التحويلات
// (transfers.js) بنفس البنية والسلوك تمامًا، لكن للمقبوضات النقدية بدل التحويلات. لا تخلط بينها وبين شاشة
// "الصندوق" (cash.js): تلك شاشة ملخص (رصيد افتتاحي + كل الداخل والخارج) لا قائمة عمليات فردية قابلة للحذف/التعديل
import * as db from './database.js';
import { formatMoney, formatDateTime, escapeHtml, dateRangeFor } from './utils.js';
import { emptyState, toastSuccess, toastError, confirmDialog } from './ui.js';

let currentFilter = 'today';

export async function renderCashReceipts(container) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  await renderForFilter(container, currentFilter);
}

async function renderForFilter(container, filter) {
  currentFilter = filter;
  const range = filter === 'all' ? {} : dateRangeFor(filter === 'week' ? 'last7' : filter === 'month' ? 'month' : 'today');
  let receipts = await db.getCashReceipts(range);

  // إكمال اسم الزبون لعمليات الدفعات المستقلة
  const missingNames = receipts.filter(r => r.source === 'payment' && !r.customerName);
  const uniqueIds = [...new Set(missingNames.map(r => r.customerId))];
  const nameMap = {};
  for (const id of uniqueIds) { const c = await db.getCustomer(id); nameMap[id] = c ? c.name : 'زبون'; }
  receipts = receipts.map(r => r.source === 'payment' ? { ...r, customerName: nameMap[r.customerId] || 'زبون' } : r);

  const total = receipts.reduce((s, r) => s + r.amount, 0);

  container.innerHTML = `
    <div class="card" style="text-align:center;">
      <div class="stat-label" style="justify-content:center;">إجمالي المقبوضات النقدية</div>
      <div class="stat-value" style="color:var(--success);font-size:26px;">${formatMoney(total)}</div>
    </div>
    <div class="tabs">
      ${[['today','اليوم'],['week','هذا الأسبوع'],['month','هذا الشهر'],['all','الكل']].map(([k,l]) => `<button class="tab-btn ${filter===k?'active':''}" data-filter="${k}">${l}</button>`).join('')}
    </div>
    <div class="card" style="padding:6px 10px;">
      ${receipts.length ? receipts.map(receiptRow).join('') : emptyState('💵', 'لا توجد مقبوضات نقدية في هذه الفترة')}
    </div>
  `;
  container.querySelectorAll('[data-filter]').forEach(btn => btn.onclick = () => renderForFilter(container, btn.dataset.filter));
  bindRowActions(container, filter);
}

// نفس منطق bindRowActions بـtransfers.js بالضبط (راجع تعليقها هناك): تعديل متاح فقط لمصدره فاتورة بيع
// (يفتح شاشة تعديل الفاتورة الكاملة)، ودفعة تحصيل دين مستقلة لها حذف فقط - لا شاشة تعديل لها بالتطبيق كله
function bindRowActions(container, filter) {
  container.querySelectorAll('[data-edit-receipt]').forEach(el => el.onclick = (ev) => {
    ev.stopPropagation();
    window.location.hash = `#/sale/edit/${el.dataset.editReceipt}`;
  });
  container.querySelectorAll('[data-delete-receipt]').forEach(el => el.onclick = async (ev) => {
    ev.stopPropagation();
    const [source, id] = el.dataset.deleteReceipt.split(':');
    if (source === 'sale') {
      const ok = await confirmDialog({ title: 'حذف الفاتورة', message: 'سيتم حذف الفاتورة كاملة بكل بنودها (ليس المبلغ النقدي فقط)، وستتأثر أرصدة الزبون والصندوق. لا يمكن التراجع عن هذا الإجراء.' });
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

function receiptRow(r) {
  return `
    <div class="list-item">
      <div class="avatar" style="background:var(--success-light);color:var(--success);">💵</div>
      <div class="info">
        <div class="title">${escapeHtml(r.customerName || 'زبون بدون اسم')}</div>
        <div class="subtitle">${escapeHtml(r.notes || '')}</div>
      </div>
      <div style="text-align:left;">
        <div class="amount cash">${formatMoney(r.amount)}</div>
        <div class="meta">${formatDateTime(r.date)}</div>
      </div>
      <div class="row-actions">
        ${r.source === 'sale' ? `<button class="edit-btn" data-edit-receipt="${r.id}" title="تعديل الفاتورة">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>
        </button>` : ''}
        <button class="remove-btn" data-delete-receipt="${r.source}:${r.id}" title="حذف">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
        </button>
      </div>
    </div>`;
}

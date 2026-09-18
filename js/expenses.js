// إدارة المصروفات
import * as db from './database.js';
import { formatMoney, formatDateTime, escapeHtml, EXPENSE_CATEGORIES } from './utils.js';
import { toastError, toastSuccess, setLoading, openSheet, closeSheet, confirmDialog, emptyState } from './ui.js';

export async function renderExpenses(container) {
  container.innerHTML = `<div class="skeleton" style="height:200px;"></div>`;
  const expenses = await db.getExpenses();
  render(container, expenses);
}

function render(container, expenses) {
  const total = expenses.reduce((s, e) => s + e.amount, 0);
  container.innerHTML = `
    <div class="card" style="text-align:center;">
      <div class="stat-label" style="justify-content:center;">إجمالي المصروفات</div>
      <div class="stat-value" style="color:var(--danger);font-size:26px;">${formatMoney(total)}</div>
    </div>
    <button class="btn btn-primary btn-block" id="add-expense-btn" style="margin-bottom:14px;">+ إضافة مصروف</button>
    <div class="card" style="padding:6px 10px;">
      ${expenses.length ? expenses.map(expenseRow).join('') : emptyState('💸', 'لا توجد مصروفات مسجلة')}
    </div>
  `;
  container.querySelector('#add-expense-btn').onclick = () => openExpenseSheet(container);
  container.querySelectorAll('[data-delete]').forEach(btn => btn.onclick = async (e) => {
    e.stopPropagation();
    const ok = await confirmDialog({ title: 'حذف المصروف', message: 'هل تريد حذف هذا المصروف؟' });
    if (!ok) return;
    await db.deleteExpense(btn.dataset.delete);
    toastSuccess('تم حذف المصروف');
    renderExpenses(container);
  });
}

function expenseRow(e) {
  return `
    <div class="list-item">
      <div class="avatar" style="background:var(--danger-light);color:var(--danger);">💸</div>
      <div class="info">
        <div class="title">${escapeHtml(e.category)}</div>
        <div class="subtitle">${e.notes ? escapeHtml(e.notes) + ' - ' : ''}${formatDateTime(e.created_at)}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <div class="amount debt">${formatMoney(e.amount)}</div>
        <button class="remove-btn" data-delete="${e.id}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
        </button>
      </div>
    </div>`;
}

function openExpenseSheet(container) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>+ إضافة مصروف</h3></div>
    <div class="form-group"><label>المبلغ</label><input type="number" id="ex-amount" step="0.5" min="0" placeholder="0"></div>
    <div class="form-group"><label>التصنيف</label>
      <select id="ex-category">${EXPENSE_CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
    </div>
    <div class="form-group"><label>ملاحظات (اختياري)</label><textarea id="ex-notes"></textarea></div>
    <button class="btn btn-primary btn-block" id="ex-save">حفظ المصروف</button>
  `, { onOpen: (el) => el.querySelector('#ex-amount').focus() });

  overlay.querySelector('#ex-save').onclick = async () => {
    const btn = overlay.querySelector('#ex-save');
    const amount = parseFloat(overlay.querySelector('#ex-amount').value);
    if (!amount || amount <= 0) return toastError('أدخل مبلغًا صحيحًا');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      await db.addExpense({ amount, category: overlay.querySelector('#ex-category').value, notes: overlay.querySelector('#ex-notes').value.trim() });
      closeSheet();
      toastSuccess('تم حفظ المصروف');
      renderExpenses(container);
    } catch (err) {
      toastError('حدث خطأ أثناء حفظ المصروف. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };
}

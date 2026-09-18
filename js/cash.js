// شاشة الصندوق: حركة الأموال والرصيد المتوقع
import * as db from './database.js';
import { formatMoney, toCents } from './utils.js';
import { toastError, toastSuccess, setLoading, openSheet, closeSheet } from './ui.js';

export async function renderCash(container) {
  container.innerHTML = `<div class="skeleton" style="height:250px;"></div>`;
  const summary = await db.getCashSummary();
  render(container, summary);
}

function render(container, s) {
  container.innerHTML = `
    <div class="card">
      <div class="stat-label" style="justify-content:center;margin-bottom:6px;">الرصيد المتوقع في الصندوق</div>
      <div style="text-align:center;font-size:30px;font-weight:800;color:var(--primary-dark);">${formatMoney(s.expectedCash)}</div>
    </div>
    <div class="card">
      <table class="simple-table">
        <tbody>
          <tr><td>الرصيد الافتتاحي</td><td style="text-align:left;font-weight:700;">${formatMoney(s.opening)}</td></tr>
          <tr><td>المبيعات النقدية</td><td style="text-align:left;font-weight:700;color:var(--success);">+${formatMoney(s.cashSales)}</td></tr>
          <tr><td>تحصيل ديون نقدية</td><td style="text-align:left;font-weight:700;color:var(--success);">+${formatMoney(s.cashPayments)}</td></tr>
          <tr><td>مصروفات</td><td style="text-align:left;font-weight:700;color:var(--danger);">-${formatMoney(s.totalExpenses)}</td></tr>
        </tbody>
      </table>
    </div>
    <div class="card">
      <div class="section-title" style="margin-top:0;">إحصائيات إضافية</div>
      <table class="simple-table">
        <tbody>
          <tr><td>إجمالي التحويلات (مبيعات)</td><td style="text-align:left;font-weight:700;color:var(--blue);">${formatMoney(s.transferSales)}</td></tr>
          <tr><td>إجمالي التحويلات (تحصيل ديون)</td><td style="text-align:left;font-weight:700;color:var(--blue);">${formatMoney(s.transferPayments)}</td></tr>
          <tr><td>مبيعات آجلة (دين)</td><td style="text-align:left;font-weight:700;color:var(--danger);">${formatMoney(s.debtSales)}</td></tr>
        </tbody>
      </table>
    </div>
    <button class="btn btn-outline btn-block" id="set-opening-btn">تعديل الرصيد الافتتاحي</button>
  `;
  container.querySelector('#set-opening-btn').onclick = () => openOpeningBalanceSheet(container, s.opening);
}

function openOpeningBalanceSheet(container, currentOpening) {
  const overlay = openSheet(`
    <div class="sheet-header"><h3>الرصيد الافتتاحي للصندوق</h3></div>
    <div class="form-group"><label>المبلغ</label><input type="number" id="ob-amount" step="0.5" min="0" value="${currentOpening / 100}"></div>
    <button class="btn btn-primary btn-block" id="ob-save">حفظ</button>
  `, { onOpen: (el) => el.querySelector('#ob-amount').focus() });

  overlay.querySelector('#ob-save').onclick = async () => {
    const btn = overlay.querySelector('#ob-save');
    const amount = parseFloat(overlay.querySelector('#ob-amount').value);
    if (isNaN(amount) || amount < 0) return toastError('أدخل مبلغًا صحيحًا');
    setLoading(btn, true, 'جاري الحفظ...');
    try {
      await db.updateSettings({ openingCashBalance: toCents(amount) });
      closeSheet();
      toastSuccess('تم تحديث الرصيد الافتتاحي');
      renderCash(container);
    } catch (err) {
      toastError('حدث خطأ أثناء الحفظ. حاول مرة أخرى.');
      setLoading(btn, false);
    }
  };
}

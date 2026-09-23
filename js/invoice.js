// عرض الفاتورة: طباعة، مشاركة، تعديل، حذف
import * as db from './database.js';
import { getCurrentUser, canDelete } from './auth.js';
import { formatMoney, formatDateTime, escapeHtml } from './utils.js';
import { toastError, toastSuccess, confirmDialog } from './ui.js';

export async function renderInvoice(container, saleId) {
  const [sale, settings, user] = await Promise.all([db.getSale(saleId), db.getSettings(), getCurrentUser()]);
  if (!sale) { container.innerHTML = `<div class="card">الفاتورة غير موجودة</div>`; return; }
  const canManage = canDelete(user);

  const methodLabel = { paid: sale.paid_transfer > 0 && sale.paid_cash === 0 && sale.paid_debt === 0 ? 'تحويل' : (sale.paid_debt === 0 ? 'نقدي' : 'دفع مقسم'), partial: 'دفع مقسم', debt: 'دين' }[sale.payment_status] || 'دفع مقسم';

  container.innerHTML = `
    <div class="card" id="invoice-card">
      <div style="text-align:center;margin-bottom:14px;">
        <div style="font-size:20px;font-weight:800;">${escapeHtml(settings.shopName)}</div>
        <div style="font-size:12.5px;color:var(--text-muted);">${settings.phone || ''} ${settings.address ? '- ' + escapeHtml(settings.address) : ''}</div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:13px;color:var(--text-muted);margin-bottom:6px;">
        <span>${sale.invoice_number}</span>
        <span>${formatDateTime(sale.created_at)}</span>
      </div>
      <div style="font-weight:700;margin-bottom:10px;">الزبون: ${escapeHtml(sale.customer_name_snapshot || 'زبون بدون اسم')}</div>
      ${sale.items.length ? `
      <table class="simple-table">
        <thead><tr><th>المنتج</th><th>الكمية</th><th>السعر</th><th>الإجمالي</th></tr></thead>
        <tbody>
          ${sale.items.map(it => `<tr><td>${escapeHtml(it.product_name)}</td><td>${it.quantity} ${it.unit}</td><td>${formatMoney(it.selling_price)}</td><td>${formatMoney(it.total_price)}</td></tr>`).join('')}
        </tbody>
      </table>
      ` : `<p style="font-size:13px;color:var(--text-muted);">دين مباشر بدون منتجات</p>`}
      <div class="totals-box">
        <div class="row grand"><span>الإجمالي</span><span>${formatMoney(sale.total_amount)}</span></div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;">
        ${sale.paid_cash > 0 ? `<span class="badge cash">نقدي ${formatMoney(sale.paid_cash)}</span>` : ''}
        ${sale.paid_transfer > 0 ? `<span class="badge transfer">تحويل ${formatMoney(sale.paid_transfer)}</span>` : ''}
        ${sale.paid_debt > 0 ? `<span class="badge debt">دين ${formatMoney(sale.paid_debt)}</span>` : ''}
      </div>
      ${sale.paid_debt > 0 ? `<div style="font-size:13px;color:var(--danger);font-weight:700;">الرصيد المتبقي على الزبون من هذه الفاتورة: ${formatMoney(sale.paid_debt)}</div>` : ''}
      ${sale.notes ? `<div style="margin-top:10px;font-size:13px;color:var(--text-muted);">ملاحظات: ${escapeHtml(sale.notes)}</div>` : ''}
      <div class="print-only" style="text-align:center;margin-top:16px;font-size:12px;color:#888;">شكرًا لتعاملكم معنا</div>
    </div>

    <div class="no-print" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px;">
      <button class="btn btn-secondary" id="inv-print">🖨️ طباعة</button>
      <button class="btn btn-secondary" id="inv-share">📤 مشاركة</button>
      <button class="btn btn-secondary" id="inv-pdf">📄 PDF</button>
    </div>
    ${canManage ? `
    <div class="no-print" style="display:grid;grid-template-columns:${sale.items.length ? '1fr 1fr' : '1fr'};gap:8px;">
      ${sale.items.length ? `<button class="btn btn-outline" id="inv-edit">تعديل الفاتورة</button>` : ''}
      <button class="btn btn-danger" id="inv-delete">حذف الفاتورة</button>
    </div>` : ''}
  `;

  container.querySelector('#inv-print').onclick = () => window.print();
  container.querySelector('#inv-pdf').onclick = () => {
    toastSuccess('استخدم خيار "حفظ كـ PDF" من نافذة الطباعة');
    window.print();
  };
  container.querySelector('#inv-share').onclick = () => shareInvoice(sale, settings);

  if (canManage) {
    const editBtn = container.querySelector('#inv-edit');
    if (editBtn) editBtn.onclick = () => window.location.hash = `#/sale/edit/${sale.id}`;
    container.querySelector('#inv-delete').onclick = async () => {
      const ok = await confirmDialog({ title: 'حذف الفاتورة', message: `سيتم حذف فاتورة ${sale.invoice_number} وستتأثر أرصدة الزبون والصندوق.` });
      if (!ok) return;
      try {
        await db.deleteSale(sale.id);
        toastSuccess('تم حذف الفاتورة');
        window.location.hash = '#/dashboard';
      } catch (err) {
        toastError('حدث خطأ أثناء حذف الفاتورة. حاول مرة أخرى.');
      }
    };
  }
}

async function shareInvoice(sale, settings) {
  const text = `${settings.shopName}\nفاتورة ${sale.invoice_number}\nالزبون: ${sale.customer_name_snapshot}\nالإجمالي: ${formatMoney(sale.total_amount)}\nالتاريخ: ${formatDateTime(sale.created_at)}`;
  if (navigator.share) {
    try { await navigator.share({ title: sale.invoice_number, text }); }
    catch (e) { /* المستخدم أغلق نافذة المشاركة */ }
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    toastSuccess('تم نسخ تفاصيل الفاتورة');
  }
}

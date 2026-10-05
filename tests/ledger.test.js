// يثبّت: (1) ظهور الملاحظات بتفاصيل حركة الدين/الدفعة بسجل حساب الزبون بعد إصلاح getCustomerLedger
// و (2) إمكانية حذف حركة دفعة (تحذف الدفعة فقط) وحركة دين (تحذف الفاتورة كاملة) من نفس السجل
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    await page.evaluate(async () => {
      const db = await import('./js/database.js');
      const p = await db.addProduct({ name: 'منتج', unit: 'قطعة', selling_price: '50', cost_price: '30' });
      const c = await db.addCustomer({ name: 'زبون كشف الحساب' });
      await db.createSale({
        items: [{ product_id: p.id, product_name: p.name, unit: p.unit, quantity: 1, selling_price: '50', cost_price: '30' }],
        paidDebt: 50, customerId: c.id, customerName: c.name, notes: 'دين ملاحظة اختبار'
      });
      await db.addPayment({ customerId: c.id, amount: 20, method: 'cash', notes: 'دفعة ملاحظة اختبار' });
      window.__testCustomerId = c.id;
      const d = document.createElement('div'); d.id = 'test-container'; document.body.appendChild(d);
    });

    await page.evaluate(async () => {
      const mod = await import('./js/customers.js');
      await mod.renderCustomerDetail(document.getElementById('test-container'), window.__testCustomerId);
    });
    await page.waitForTimeout(250);

    const ledgerCountBefore = await page.evaluate(() => document.querySelectorAll('[data-ledger-open]').length);
    assert('حركتان بسجل الزبون (دين + دفعة)', ledgerCountBefore === 2);

    // فتح تفاصيل أول حركة (الأحدث، أي الدفعة) والتحقق من ظهور ملاحظتها
    await page.click('[data-ledger-open]');
    await page.waitForTimeout(150);
    const paymentNoteShown = await page.evaluate(() => document.querySelector('.sheet')?.textContent.includes('دفعة ملاحظة اختبار'));
    assert('ملاحظة الدفعة تظهر بتفاصيل الحركة', paymentNoteShown);
    await page.evaluate(async () => { const ui = await import('./js/ui.js'); ui.closeSheet(); });
    await page.waitForTimeout(250);

    // فتح تفاصيل حركة الدين والتحقق من ظهور ملاحظتها
    const debtRows = await page.evaluate(() => Array.from(document.querySelectorAll('[data-ledger-open]')).map(el => el.dataset.ledgerOpen));
    const debtRowSelector = debtRows.find(v => v.startsWith('sale:'));
    await page.evaluate((key) => {
      document.querySelector(`[data-ledger-open="${key}"]`).click();
    }, debtRowSelector);
    await page.waitForTimeout(150);
    const debtNoteShown = await page.evaluate(() => document.querySelector('.sheet')?.textContent.includes('دين ملاحظة اختبار'));
    assert('ملاحظة الدين تظهر بتفاصيل الحركة', debtNoteShown);
    await page.evaluate(async () => { const ui = await import('./js/ui.js'); ui.closeSheet(); });
    await page.waitForTimeout(250);

    // حذف حركة الدفعة
    const paymentKey = (await page.evaluate(() => Array.from(document.querySelectorAll('[data-ledger-open]')).map(el => el.dataset.ledgerOpen))).find(v => v.startsWith('payment:'));
    await page.evaluate((key) => document.querySelector(`[data-ledger-delete="${key}"]`).click(), paymentKey);
    await page.waitForTimeout(150);
    await page.click('[data-act="confirm"]');
    await page.waitForTimeout(300);
    const afterPaymentDelete = await page.evaluate(() => document.querySelectorAll('[data-ledger-open]').length);
    assert('بعد حذف حركة الدفعة يتبقى حركة واحدة فقط', afterPaymentDelete === 1);

    // حذف حركة الدين (يحذف الفاتورة كاملة)
    const debtKey = (await page.evaluate(() => Array.from(document.querySelectorAll('[data-ledger-open]')).map(el => el.dataset.ledgerOpen))).find(v => v.startsWith('sale:'));
    await page.evaluate((key) => document.querySelector(`[data-ledger-delete="${key}"]`).click(), debtKey);
    await page.waitForTimeout(150);
    await page.click('[data-act="confirm"]');
    await page.waitForTimeout(300);
    const afterDebtDelete = await page.evaluate(() => document.querySelectorAll('[data-ledger-open]').length);
    assert('بعد حذف حركة الدين لا تبقى أي حركة', afterDebtDelete === 0);
  });
  summary();
})();

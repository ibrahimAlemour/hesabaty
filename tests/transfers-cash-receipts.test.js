// يثبّت: إمكانية حذف/تعديل عناصر شاشتي "التحويلات" و"المقبوضات النقدية" (مرآتان لنفس البنية). عنصر مصدره
// فاتورة بيع: زر تعديل ينقل لشاشة تعديل الفاتورة، وزر حذف يحذف الفاتورة كاملة (لا حقل التحويل/النقد فقط -
// لا يوجد تعديل جزئي لحقل واحد بفاتورة قد تحتوي أصنافًا وطرق دفع متعددة). عنصر مصدره دفعة تحصيل دين مستقلة:
// حذف فقط (لا شاشة تعديل دفعة بالتطبيق كله) - ويتحقق أن الإجمالي المعروض يُحدَّث فورًا بعد كل حذف.
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    const ids = await page.evaluate(async () => {
      const db = await import('./js/database.js');
      await db.updateSettings({ backendMode: 'local', currentUser: { id: 'u1', name: 'المالك', role: 'owner' } });
      const c1 = await db.addCustomer({ name: 'زبون التحويل' });
      const c2 = await db.addCustomer({ name: 'زبون النقد' });

      const { sale: saleTransfer } = await db.createSale({
        items: [{ product_id: null, product_name: 'منتج', unit: 'قطعة', quantity: 1, selling_price: '200', cost_price: '0' }],
        paidTransfer: 200, customerId: c1.id, customerName: c1.name, notes: ''
      });
      const payTransfer = await db.addPayment({ customerId: c1.id, amount: 50, method: 'transfer', notes: 'دفعة تحويل' });

      const { sale: saleCash } = await db.createSale({
        items: [{ product_id: null, product_name: 'منتج', unit: 'قطعة', quantity: 1, selling_price: '80', cost_price: '0' }],
        paidCash: 80, customerId: c2.id, customerName: c2.name, notes: ''
      });
      const payCash = await db.addPayment({ customerId: c2.id, amount: 30, method: 'cash', notes: 'دفعة نقدية' });

      const d = document.createElement('div'); d.id = 'test-container'; document.body.appendChild(d);
      return { saleTransferId: saleTransfer.id, payTransferId: payTransfer.id, saleCashId: saleCash.id, payCashId: payCash.id };
    });

    // ========== شاشة التحويلات ==========
    await page.evaluate(async () => {
      const mod = await import('./js/transfers.js');
      await mod.renderTransfers(document.getElementById('test-container'));
    });
    await page.waitForTimeout(250);

    let text = await page.evaluate(() => document.getElementById('test-container').innerText);
    assert('شاشة التحويلات: الإجمالي الأولي صحيح (200+50=250)', text.includes('250.00'));

    const editBtnCount = await page.evaluate(() => document.querySelectorAll('[data-edit-transfer]').length);
    assert('زر التعديل يظهر فقط لعنصر مصدره فاتورة بيع (وليس للدفعة المستقلة)', editBtnCount === 1);

    await page.click('[data-delete-transfer^="payment:"]');
    await page.waitForTimeout(150);
    await page.click('[data-act="confirm"]');
    await page.waitForTimeout(250);
    text = await page.evaluate(() => document.getElementById('test-container').innerText);
    assert('حذف عنصر الدفعة: الإجمالي يُحدَّث فورًا إلى 200.00', text.includes('200.00') && !text.includes('250.00'));

    await page.click('[data-edit-transfer]');
    await page.waitForTimeout(100);
    const hashAfterEdit = await page.evaluate(() => window.location.hash);
    assert('زر تعديل عنصر الفاتورة ينقل لشاشة تعديل الفاتورة الصحيحة', hashAfterEdit === `#/sale/edit/${ids.saleTransferId}`);

    // ========== شاشة المقبوضات النقدية ==========
    await page.evaluate(() => { window.location.hash = ''; });
    await page.evaluate(async () => {
      const mod = await import('./js/cash-receipts.js');
      await mod.renderCashReceipts(document.getElementById('test-container'));
    });
    await page.waitForTimeout(250);

    text = await page.evaluate(() => document.getElementById('test-container').innerText);
    assert('شاشة المقبوضات النقدية: الإجمالي الأولي صحيح (80+30=110)', text.includes('110.00'));

    await page.click('[data-delete-receipt^="sale:"]');
    await page.waitForTimeout(150);
    await page.click('[data-act="confirm"]');
    await page.waitForTimeout(250);
    text = await page.evaluate(() => document.getElementById('test-container').innerText);
    assert('حذف عنصر الفاتورة النقدية: الفاتورة كاملة تُحذف والإجمالي يصبح 30.00', text.includes('30.00') && !text.includes('110.00'));

    const localSales = await page.evaluate(async () => (await (await import('./js/database.js')).getSales()).length);
    assert('حذف الفاتورة فعليًا (soft-delete) لا يظهر إطلاقًا بـgetSales بعدها', localSales === 1); // تبقى فقط فاتورة التحويل
  });
  summary();
})();

// يثبّت ميزة "الخصم" عند تسجيل دفعة (للزبون وللمورد كليهما): مبلغ يُخفَّض من الدين/المستحق دون إدخاله
// فعليًا للصندوق (تنازل عند التحصيل) - يظهر بسجل الحركات، ويُحتسب بالرصيد الجديد تمامًا كالمبلغ المحصَّل،
// لكن حركة الصندوق (cashTransactions) تبقى بقيمة المبلغ الفعلي المحصَّل فقط دون الخصم.
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    const ids = await page.evaluate(async () => {
      const db = await import('./js/database.js');
      await db.updateSettings({ backendMode: 'local', currentUser: { id: 'u1', name: 'المالك', role: 'owner' } });
      const customer = await db.addCustomer({ name: 'زبون خصم الدفعة' });
      const { sale } = await db.createSale({
        items: [{ product_id: null, product_name: 'منتج', unit: 'قطعة', quantity: 1, selling_price: '100', cost_price: '0' }],
        paidDebt: 100, customerId: customer.id, customerName: customer.name, notes: ''
      });
      const supplier = await db.addSupplier({ name: 'مورد خصم الدفعة' });
      await db.addPurchase({
        supplierId: supplier.id, supplierName: supplier.name, supplierInvoiceNumber: '', purchaseDate: new Date().toISOString(),
        items: [{ product_id: null, product_name: 'منتج', unit: 'قطعة', quantity: 1, purchase_price: '80' }],
        paidCash: 0, paidTransfer: 0, paidCredit: 80, discount: 0, extraCosts: 0, notes: ''
      });
      const d = document.createElement('div'); d.id = 'test-container'; document.body.appendChild(d);
      return { customerId: customer.id, supplierId: supplier.id, saleId: sale.id };
    });

    // ========== دفعة زبون بخصم: يدفع 70 نقدًا + خصم 30 = تسوية كامل دين الـ100 ==========
    await page.evaluate(async (id) => {
      const mod = await import('./js/customers.js');
      await mod.renderCustomerDetail(document.getElementById('test-container'), id);
    }, ids.customerId);
    await page.waitForTimeout(250);
    await page.click('#record-payment-btn');
    await page.waitForTimeout(200);
    const hasDiscountInput = await page.evaluate(() => !!document.getElementById('pay-discount'));
    assert('شاشة دفعة الزبون: يوجد حقل خصم', hasDiscountInput);
    await page.fill('#pay-amount', '70');
    await page.fill('#pay-discount', '30');
    await page.waitForTimeout(100);
    const previewText = await page.evaluate(() => document.getElementById('pay-preview').textContent);
    assert('المعاينة تُظهر الرصيد الجديد (صفر) شاملًا الخصم', previewText.includes('0.00'));
    await page.click('#pay-save');
    await page.waitForTimeout(350);

    const afterCustomerPayment = await page.evaluate(async (id) => {
      const db = await import('./js/database.js');
      const balance = await db.getCustomerBalance(id);
      const ledger = await db.getCustomerLedger(id);
      const paymentEntry = ledger.find(e => e.type === 'payment');
      const cashSummary = await db.getCashSummary({});
      return { balance, paymentEntry, cashPayments: cashSummary.cashPayments };
    }, ids.customerId);
    assert('رصيد الزبون أصبح صفرًا (100 دين - 70 مدفوع - 30 خصم)', afterCustomerPayment.balance === 0);
    assert('حركة الدفعة بالسجل: المبلغ الكلي = 100 (70 محصَّل + 30 خصم)', afterCustomerPayment.paymentEntry.amount === 10000);
    assert('حركة الدفعة بالسجل: discount = 30، collectedAmount = 70', afterCustomerPayment.paymentEntry.discount === 3000 && afterCustomerPayment.paymentEntry.collectedAmount === 7000);
    assert('ملخص الصندوق يحتسب المبلغ المحصَّل فعليًا فقط (70) لا المبلغ شاملًا الخصم (100)', afterCustomerPayment.cashPayments === 7000);

    // ========== دفعة خصم بالكامل بدون أي مبلغ نقدي (تنازل كامل) ==========
    const customer2Id = await page.evaluate(async () => (await (await import('./js/database.js')).addCustomer({ name: 'زبون تنازل كامل' })).id);
    const pureDiscountResult = await page.evaluate(async (id) => {
      const db = await import('./js/database.js');
      try {
        const p = await db.addPayment({ customerId: id, amount: 0, discount: 25, method: 'cash', notes: 'تنازل كامل' });
        return { ok: true, discount: p.discount, amount: p.amount };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }, customer2Id);
    assert('دفعة بخصم فقط بدون مبلغ (amount=0) تُقبَل (تنازل كامل بدون تحصيل نقدي)', pureDiscountResult.ok && pureDiscountResult.discount === 2500 && pureDiscountResult.amount === 0);

    const rejectedResult = await page.evaluate(async (id) => {
      const db = await import('./js/database.js');
      try {
        await db.addPayment({ customerId: id, amount: 0, discount: 0, method: 'cash', notes: '' });
        return { rejected: false };
      } catch (err) {
        return { rejected: true };
      }
    }, customer2Id);
    assert('دفعة بدون مبلغ ولا خصم (كلاهما صفر) تُرفَض', rejectedResult.rejected);

    // ========== نفس الميزة بدفعة المورد ==========
    await page.evaluate(async (id) => {
      const mod = await import('./js/suppliers.js');
      await mod.renderSupplierDetail(document.getElementById('test-container'), id);
    }, ids.supplierId);
    await page.waitForTimeout(250);
    await page.click('#record-payment-btn');
    await page.waitForTimeout(200);
    const hasSupplierDiscountInput = await page.evaluate(() => !!document.getElementById('sp-discount'));
    assert('شاشة دفعة المورد: يوجد حقل خصم', hasSupplierDiscountInput);
    await page.fill('#sp-amount', '50');
    await page.fill('#sp-discount', '30');
    await page.waitForTimeout(100);
    await page.click('#sp-save');
    await page.waitForTimeout(350);

    const afterSupplierPayment = await page.evaluate(async (id) => {
      const db = await import('./js/database.js');
      const balance = await db.getSupplierBalance(id);
      const ledger = await db.getSupplierLedger(id);
      const paymentEntry = ledger.find(e => e.type === 'supplier_payment');
      return { balance, paymentEntry };
    }, ids.supplierId);
    assert('رصيد المورد أصبح صفرًا (80 مستحق - 50 مدفوع - 30 خصم)', afterSupplierPayment.balance === 0);
    assert('حركة دفعة المورد بالسجل: discount = 30 محفوظ بشكل صحيح', afterSupplierPayment.paymentEntry.discount === 3000);
  });
  summary();
})();

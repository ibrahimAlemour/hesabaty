// يثبّت: (1) الضغط على حركة "فاتورة بيع" بسجل الزبون (بالتبويب العادي وبشيت "عرض جميع الحركات" كليهما)
// ينقل مباشرة لشاشة الفاتورة الكاملة (#/invoice/:id) بدل شيت "تفاصيل الحركة" العام - فتظهر فيها كل الأصناف
// (الاسم/الكمية/السعر/الإجمالي) وزر "تعديل الفاتورة" إن وُجدت أصناف. (2) تعديل فاتورة بيع (تغيير كمية/سعر
// صنف) عبر renderEditSale ينعكس فورًا وبشكل صحيح على: رصيد الزبون، سجل حركاته، وصافي الربح المحفوظ بالفاتورة.
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    const ids = await page.evaluate(async () => {
      const db = await import('./js/database.js');
      await db.updateSettings({ backendMode: 'local', currentUser: { id: 'u1', name: 'المالك', role: 'owner' } });
      const product = await db.addProduct({ name: 'منتج اختبار الفاتورة', unit: 'قطعة', selling_price: '50', cost_price: '30' });
      const customer = await db.addCustomer({ name: 'زبون تعديل الفاتورة' });
      const { sale } = await db.createSale({
        items: [{ product_id: product.id, product_name: product.name, unit: product.unit, quantity: 2, selling_price: '50', cost_price: '30' }],
        paidDebt: 100, customerId: customer.id, customerName: customer.name, notes: ''
      });
      const d = document.createElement('div'); d.id = 'test-container'; document.body.appendChild(d);
      return { productId: product.id, customerId: customer.id, saleId: sale.id };
    });

    // ========== (1) الضغط على حركة فاتورة البيع بالتبويب العادي ينقل لشاشة الفاتورة ==========
    await page.evaluate(async (id) => {
      const mod = await import('./js/customers.js');
      await mod.renderCustomerDetail(document.getElementById('test-container'), id);
    }, ids.customerId);
    await page.waitForTimeout(250);
    await page.click(`[data-ledger-open="sale:${ids.saleId}"]`);
    await page.waitForTimeout(150);
    const hash1 = await page.evaluate(() => window.location.hash);
    assert('الضغط على حركة الفاتورة بالتبويب العادي ينقل لـ#/invoice/:id', hash1 === `#/invoice/${ids.saleId}`);
    await page.evaluate(() => { window.location.hash = ''; });
    await page.waitForTimeout(150);

    // ========== نفس السلوك من داخل شيت "عرض جميع الحركات" (الحركات المعروضة هناك داخل Overlay) ==========
    // نضيف 4 دفعات أخرى حتى يتجاوز عدد الحركات الحد (TAB_LIMIT=4) فيظهر زر "عرض جميع الحركات"
    await page.evaluate(async (id) => {
      const db = await import('./js/database.js');
      for (let i = 0; i < 4; i++) await db.addPayment({ customerId: id, amount: 10, method: 'cash', notes: '' });
    }, ids.customerId);
    await page.evaluate(async (id) => {
      const mod = await import('./js/customers.js');
      await mod.renderCustomerDetail(document.getElementById('test-container'), id);
    }, ids.customerId);
    await page.waitForTimeout(250);
    const hasViewAll = await page.evaluate(() => !!document.querySelector('[data-view-all="ledger"]'));
    assert('زر "عرض جميع الحركات" يظهر (5 حركات > الحد 4)', hasViewAll);
    await page.click('[data-view-all="ledger"]');
    await page.waitForTimeout(150);
    await page.click(`.sheet [data-ledger-open="sale:${ids.saleId}"]`);
    await page.waitForTimeout(150);
    const hash2 = await page.evaluate(() => window.location.hash);
    assert('الضغط على حركة الفاتورة داخل شيت "عرض جميع الحركات" ينقل لـ#/invoice/:id أيضًا', hash2 === `#/invoice/${ids.saleId}`);
    const sheetClosedAfterNav = await page.evaluate(() => !document.querySelector('.overlay.show'));
    assert('الشيت يُغلَق تلقائيًا قبل الانتقال للفاتورة', sheetClosedAfterNav);
    await page.evaluate(() => { window.location.hash = ''; });
    await page.waitForTimeout(150);

    // ========== (2) شاشة الفاتورة: تعرض الأصناف وزر التعديل ==========
    await page.evaluate(async (saleId) => {
      const mod = await import('./js/invoice.js');
      await mod.renderInvoice(document.getElementById('test-container'), saleId);
    }, ids.saleId);
    await page.waitForTimeout(200);
    const invoiceRowText = await page.evaluate(() => document.querySelector('table.simple-table tbody tr')?.textContent || '');
    assert('شاشة الفاتورة تعرض اسم الصنف', invoiceRowText.includes('منتج اختبار الفاتورة'));
    assert('شاشة الفاتورة تعرض الكمية', invoiceRowText.includes('2'));
    const hasEditBtn = await page.evaluate(() => !!document.getElementById('inv-edit'));
    assert('شاشة الفاتورة: زر "تعديل الفاتورة" يظهر لوجود أصناف', hasEditBtn);

    const balanceBeforeEdit = await page.evaluate(async (id) => (await (await import('./js/database.js')).getCustomerBalance(id)), ids.customerId);
    assert('الرصيد قبل التعديل = 60 ₪ (100 ₪ دين الفاتورة - 40 ₪ دفعات)', balanceBeforeEdit === 10000 - 4000);

    // ========== تعديل الفاتورة: تغيير الكمية من 2 إلى 3 (يرفع الإجمالي من 100 إلى 150) ==========
    await page.evaluate(async (saleId) => {
      const mod = await import('./js/sales.js');
      await mod.renderEditSale(document.getElementById('test-container'), saleId);
    }, ids.saleId);
    await page.waitForTimeout(250);
    await page.fill('.item-qty[data-idx="0"]', '3');
    await page.waitForTimeout(100);
    // تعديل الكمية يرفع إجمالي الفاتورة إلى 150، لكن تقسيم الدفع (دين=100) يبقى كما كان بوضع التعديل - يجب
    // تحديثه يدويًا عبر شيت "تقسيم الدفع" (نفس ما يفعله المستخدم الحقيقي) ليطابق مجموع طرق الدفع الإجمالي الجديد
    await page.click('#split-pay-btn');
    await page.waitForTimeout(150);
    await page.fill('#sp-debt', '150');
    await page.waitForTimeout(100);
    await page.click('#sp-save');
    await page.waitForTimeout(150);
    await page.click('#complete-sale-btn');
    await page.waitForTimeout(400);

    const afterEdit = await page.evaluate(async (ctx) => {
      const db = await import('./js/database.js');
      const sale = await db.getSale(ctx.saleId);
      const balance = await db.getCustomerBalance(ctx.customerId);
      const ledger = await db.getCustomerLedger(ctx.customerId);
      return { totalAmount: sale.total_amount, totalProfit: sale.total_profit, paidDebt: sale.paid_debt, balance, ledgerCount: ledger.length };
    }, ids);
    assert('بعد التعديل: إجمالي الفاتورة أصبح 150 ₪ (3×50)', afterEdit.totalAmount === 15000);
    assert('بعد التعديل: صافي الربح أصبح 60 ₪ (3×(50-30))', afterEdit.totalProfit === 6000);
    assert('بعد التعديل: الدين بالفاتورة أصبح 150 ₪ (كان آجلًا بالكامل)', afterEdit.paidDebt === 15000);
    assert('بعد التعديل: رصيد الزبون أصبح 110 ₪ (150 - 40 ₪ دفعات)', afterEdit.balance === 15000 - 4000);
    assert('بعد التعديل: سجل الحركات ما زال يحتوي نفس عدد الحركات (فاتورة واحدة + 4 دفعات)', afterEdit.ledgerCount === 5);
  });
  summary();
})();

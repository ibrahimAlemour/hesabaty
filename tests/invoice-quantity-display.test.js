// يثبّت: الكمية (الوزن) بشاشة الفاتورة (بيع وشراء) تُعرض مقرَّبة لرقمين عشريين فقط، لا بكامل دقتها الداخلية
// (مثال: 5.043478260869565 يجب أن تظهر "5.04") - القيمة الكاملة الدقة تبقى محفوظة بقاعدة البيانات لأغراض
// الحساب الدقيق (راجع إصلاح انجراف الفاصلة العشرية بالإجمالي)، ويُقرَّب فقط ما يُعرض للمستخدم.
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    const ids = await page.evaluate(async () => {
      const db = await import('./js/database.js');
      await db.updateSettings({ backendMode: 'local', currentUser: { id: 'u1', name: 'المالك', role: 'owner' } });
      const product = await db.addProduct({ name: 'سمك بكلا', unit: 'كغ', selling_price: '23', cost_price: '15' });
      const customer = await db.addCustomer({ name: 'زبون اختبار الكمية' });
      // كمية غير مستديرة عمدًا (كما تنتج من "الإجمالي ÷ السعر" بدقة كاملة) تمامًا كمثال المستخدم
      const { sale } = await db.createSale({
        items: [{ product_id: product.id, product_name: product.name, unit: product.unit, quantity: 5.043478260869565, selling_price: '23', cost_price: '15' }],
        paidDebt: 116, customerId: customer.id, customerName: customer.name, notes: ''
      });

      const supplier = await db.addSupplier({ name: 'مورد اختبار الكمية' });
      const { purchase } = await db.addPurchase({
        supplierId: supplier.id, supplierName: supplier.name, supplierInvoiceNumber: '', purchaseDate: new Date().toISOString(),
        items: [{ product_id: null, product_name: 'دجاج', unit: 'كغ', quantity: 3.789999999, purchase_price: '20' }],
        paidCash: 75.8, paidTransfer: 0, paidCredit: 0, discount: 0, extraCosts: 0, notes: ''
      });

      const d = document.createElement('div'); d.id = 'test-container'; document.body.appendChild(d);
      return { saleId: sale.id, purchaseId: purchase.id };
    });

    await page.evaluate(async (saleId) => {
      const mod = await import('./js/invoice.js');
      await mod.renderInvoice(document.getElementById('test-container'), saleId);
    }, ids.saleId);
    await page.waitForTimeout(200);
    const saleQtyText = await page.evaluate(() => document.querySelector('table.simple-table tbody tr td:nth-child(2)')?.textContent.trim());
    assert('كمية فاتورة البيع تُعرض مقرَّبة لرقمين عشريين (5.04 لا 5.043478260869565)', saleQtyText === '5.04 كغ');

    await page.evaluate(async (purchaseId) => {
      const mod = await import('./js/purchases.js');
      await mod.renderPurchaseInvoice(document.getElementById('test-container'), purchaseId);
    }, ids.purchaseId);
    await page.waitForTimeout(200);
    const purchaseQtyText = await page.evaluate(() => document.querySelector('table.simple-table tbody tr td:nth-child(2)')?.textContent.trim());
    assert('كمية فاتورة الشراء تُعرض مقرَّبة لرقمين عشريين (3.79 لا 3.789999999)', purchaseQtyText === '3.79 كغ');

    // التأكد أن القيمة الكاملة الدقة ما زالت محفوظة بقاعدة البيانات (للحساب الدقيق) ولم تتأثر بالتقريب بالعرض
    const storedQty = await page.evaluate(async (saleId) => {
      const db = await import('./js/database.js');
      const sale = await db.getSale(saleId);
      return sale.items[0].quantity;
    }, ids.saleId);
    assert('القيمة الكاملة الدقة تبقى محفوظة بقاعدة البيانات (التقريب للعرض فقط)', Math.abs(storedQty - 5.043478260869565) < 1e-9);
  });
  summary();
})();

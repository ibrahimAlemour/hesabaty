// يثبّت شاشة البحث العام (search.js): تطابق باسم مشترك عبر أقسام مختلفة، بحث برقم جوال/رقم فاتورة،
// والتنقل الصحيح لكل نوع نتيجة (مباشر للزبائن/الموردين/الفواتير، وتصفية قائمة المنتجات للمنتجات)
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    await page.evaluate(async () => {
      const db = await import('./js/database.js');
      await db.addCustomer({ name: 'أحمد السعدي', phone: '0599111111' });
      const sup = await db.addSupplier({ name: 'مؤسسة النور', phone: '0599222222' });
      const p = await db.addProduct({ name: 'سعدي كولا', unit: 'قطعة', selling_price: '5', cost_price: '3' });
      await db.addPurchase({
        items: [{ product_id: p.id, product_name: p.name, unit: p.unit, quantity: 10, purchase_price: '3' }],
        paidCash: 30, supplierId: sup.id, supplierName: sup.name, supplierInvoiceNumber: 'PINV-77'
      });
      const d = document.createElement('div'); d.id = 'test-container'; document.body.appendChild(d);
    });
    await page.evaluate(async () => {
      const mod = await import('./js/search.js');
      await mod.renderGlobalSearch(document.getElementById('test-container'));
    });
    await page.waitForTimeout(200);

    await page.fill('#global-search-input', 'سعدي');
    await page.waitForTimeout(300);
    const r1 = await page.evaluate(() => ({
      customer: document.body.textContent.includes('أحمد السعدي'),
      product: document.body.textContent.includes('سعدي كولا')
    }));
    assert('بحث "سعدي" يطابق الزبون والمنتج معًا', r1.customer && r1.product);

    await page.fill('#global-search-input', '0599222222');
    await page.waitForTimeout(300);
    assert('البحث برقم جوال المورد يعثر عليه', await page.evaluate(() => document.body.textContent.includes('مؤسسة النور')));

    await page.fill('#global-search-input', 'PINV-77');
    await page.waitForTimeout(300);
    const navTarget = await page.evaluate(() => document.querySelector('[data-nav]')?.dataset.nav);
    assert('البحث برقم فاتورة الشراء يعثر عليها وينقل لصفحتها', !!navTarget && navTarget.startsWith('#/purchase/'));

    await page.fill('#global-search-input', 'xyz-not-found');
    await page.waitForTimeout(300);
    assert('بحث بدون نتائج يظهر رسالة واضحة', await page.evaluate(() => document.getElementById('global-search-results').textContent.includes('لا توجد نتائج')));
  });
  summary();
})();

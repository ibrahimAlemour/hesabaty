// يثبّت: زر "عرض الكل" بقسم "آخر العمليات" بالصفحة الرئيسية يفتح قائمة بكل مبيعات اليوم (لا الـ10 الأخيرة
// فقط)، مرتَّبة من الأحدث للأقدم، مع إمكانية الدخول لتفاصيل أي فاتورة منها.
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    const ids = await page.evaluate(async () => {
      const db = await import('./js/database.js');
      await db.updateSettings({ backendMode: 'local', currentUser: { id: 'u1', name: 'المالك', role: 'owner' } });
      const product = await db.addProduct({ name: 'منتج لوحة التحكم', unit: 'قطعة', selling_price: '10', cost_price: '5' });
      // 12 عملية بيع اليوم (أكثر من الـ10 المعروضة بالصفحة الرئيسية) بفواصل زمنية بسيطة لضمان ترتيب واضح
      const saleIds = [];
      for (let i = 0; i < 12; i++) {
        const { sale } = await db.createSale({
          items: [{ product_id: product.id, product_name: product.name, unit: product.unit, quantity: 1, selling_price: '10', cost_price: '5' }],
          paidCash: 10, notes: `بيع رقم ${i + 1}`
        });
        saleIds.push(sale.id);
        await new Promise(r => setTimeout(r, 5));
      }
      const d = document.createElement('div'); d.id = 'test-container'; document.body.appendChild(d);
      return { saleIds, lastSaleId: saleIds[saleIds.length - 1], firstSaleId: saleIds[0] };
    });

    await page.evaluate(async () => {
      const mod = await import('./js/dashboard.js');
      await mod.renderDashboard(document.getElementById('test-container'));
    });
    await page.waitForTimeout(250);

    const recentRowCount = await page.evaluate(() => document.querySelectorAll('#test-container [data-nav^="#/invoice/"]').length);
    assert('الصفحة الرئيسية تعرض 10 عمليات فقط كـ"آخر العمليات"', recentRowCount === 10);

    await page.click('#view-all-sales');
    await page.waitForTimeout(250);

    const sheetSaleIds = await page.evaluate(() => Array.from(document.querySelectorAll('.sheet [data-nav^="#/invoice/"]')).map(el => el.dataset.nav.replace('#/invoice/', '')));
    assert('شيت "كل مبيعات اليوم" يعرض كل الـ12 عملية بيع (لا 10 فقط)', sheetSaleIds.length === 12);
    assert('الترتيب من الأحدث للأقدم: أول عنصر بالقائمة هو آخر بيع تم تنفيذه', sheetSaleIds[0] === ids.lastSaleId);
    assert('آخر عنصر بالقائمة هو أول بيع تم تنفيذه اليوم', sheetSaleIds[sheetSaleIds.length - 1] === ids.firstSaleId);

    // الدخول لتفاصيل فاتورة من داخل الشيت يُغلقه وينقل للفاتورة الصحيحة
    await page.click(`.sheet [data-nav="#/invoice/${ids.lastSaleId}"]`);
    await page.waitForTimeout(150);
    const hash = await page.evaluate(() => window.location.hash);
    assert('الضغط على فاتورة داخل شيت "كل مبيعات اليوم" ينقل لـ#/invoice/:id الصحيحة', hash === `#/invoice/${ids.lastSaleId}`);
    const sheetClosed = await page.evaluate(() => !document.querySelector('.overlay.show'));
    assert('الشيت يُغلَق تلقائيًا عند الانتقال للفاتورة', sheetClosed);
  });
  summary();
})();

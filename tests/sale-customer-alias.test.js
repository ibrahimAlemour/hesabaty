// يثبّت: شاشة بيع جديد تدعم اسمًا مستعارًا اختياريًا بدل "زبون بدون اسم" الافتراضي عند عدم اختيار زبون مسجَّل.
// الاسم المستعار نص عرض فقط (customer_name_snapshot) - لا ينشئ زبونًا حقيقيًا ولا يؤثر على customer_id
// (يبقى null، فلا دين يمكن تسجيله على هذا "الزبون" - نفس القيد الموجود مسبقًا لأي بيع بدون زبون مسجَّل).
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    await page.evaluate(async () => {
      const db = await import('./js/database.js');
      await db.updateSettings({ backendMode: 'local', currentUser: { id: 'u1', name: 'المالك', role: 'owner' } });
      const d = document.createElement('div'); d.id = 'test-container'; document.body.appendChild(d);
      window.__salesMod = await import('./js/sales.js');
    });

    await page.evaluate(() => window.__salesMod.renderNewSale(document.getElementById('test-container')));
    await page.waitForTimeout(250);
    await page.click('#customer-row');
    await page.waitForTimeout(200);
    const hasAliasInput = await page.evaluate(() => !!document.getElementById('cash-customer-alias'));
    assert('حقل الاسم المستعار موجود بشيت اختيار الزبون', hasAliasInput);

    await page.fill('#cash-customer-alias', 'الزبون اللي بالدور');
    await page.click('#pick-cash-customer');
    await page.waitForTimeout(200);
    const headerText = await page.evaluate(() => document.getElementById('customer-row').innerText);
    assert('رأس شاشة البيع يعرض الاسم المستعار بدل "زبون بدون اسم"', headerText.includes('الزبون اللي بالدور') && !headerText.includes('بدون اسم'));

    const customerId = await page.evaluate(async () => (await (await import('./js/database.js')).addCustomer({ name: 'زبون مسجَّل حقيقي' })).id);
    await page.click('#customer-row');
    await page.waitForTimeout(200);
    await page.click(`[data-pick="${customerId}"]`);
    await page.waitForTimeout(200);
    const headerAfterRealPick = await page.evaluate(() => document.getElementById('customer-row').innerText);
    assert('اختيار زبون مسجَّل بعدها يعرض اسمه الحقيقي (الاسم المستعار القديم لا يبقى عالقًا)', headerAfterRealPick.includes('زبون مسجَّل حقيقي'));

    const saleResult = await page.evaluate(async () => {
      const db = await import('./js/database.js');
      const { sale } = await db.createSale({
        customerId: null, customerName: 'الزبون اللي بالدور',
        items: [{ product_id: null, product_name: 'منتج', unit: 'قطعة', quantity: 1, selling_price: '20', cost_price: '0' }],
        paidCash: 20, notes: ''
      });
      return sale;
    });
    assert('الفاتورة المحفوظة: customer_id يبقى فارغًا (لا زبون حقيقي أُنشئ)', saleResult.customer_id === null);
    assert('الفاتورة المحفوظة: customer_name_snapshot = الاسم المستعار المُدخَل بالضبط', saleResult.customer_name_snapshot === 'الزبون اللي بالدور');

    await page.evaluate((id) => window.__salesMod.renderEditSale(document.getElementById('test-container'), id), saleResult.id);
    await page.waitForTimeout(300);
    const editHeaderText = await page.evaluate(() => document.getElementById('customer-row').innerText);
    assert('فتح الفاتورة للتعديل يستعيد الاسم المستعار المحفوظ بشكل صحيح', editHeaderText.includes('الزبون اللي بالدور'));
  });
  summary();
})();

// يثبّت تصدير CSV بشاشة التقارير: محتوى الملف (ملخص الفترة + جدول أكثر المنتجات مبيعًا) بقيم رقمية صحيحة
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    await page.evaluate(async () => {
      const db = await import('./js/database.js');
      const p = await db.addProduct({ name: 'منتج تجريبي', unit: 'قطعة', selling_price: '10', cost_price: '6' });
      await db.createSale({
        items: [{ product_id: p.id, product_name: p.name, unit: p.unit, quantity: 3, selling_price: '10', cost_price: '6' }],
        paidCash: 30, notes: ''
      });
      const d = document.createElement('div'); d.id = 'test-container'; document.body.appendChild(d);
    });
    await page.evaluate(async () => {
      const mod = await import('./js/reports.js');
      await mod.renderReports(document.getElementById('test-container'));
    });
    await page.waitForTimeout(300);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#export-csv-btn')
    ]);
    const filename = download.suggestedFilename();
    const stream = await download.createReadStream();
    const chunks = [];
    await new Promise((resolve, reject) => {
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    const content = Buffer.concat(chunks).toString('utf8');

    assert('اسم الملف بصيغة .csv وبترميز لاتيني آمن', /^hesabaty-report-.*\.csv$/.test(filename));
    assert('الملف يحتوي BOM لعرض صحيح للعربية بإكسل', content.charCodeAt(0) === 0xFEFF);
    assert('يحتوي اسم المنتج', content.includes('منتج تجريبي'));
    assert('يحتوي قيمة المبيعات الصحيحة (30)', content.includes('30'));
    assert('يحتوي صف "إجمالي المبيعات"', content.includes('إجمالي المبيعات'));
  });
  summary();
})();

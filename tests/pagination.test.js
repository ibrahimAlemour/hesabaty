// يثبّت renderPaginatedList (ui.js): يعرض أول 30 عنصرًا فقط من قائمة طويلة، وزر "عرض المزيد" يوسّع
// الدفعة تدريجيًا بدل بناء DOM ضخم لكل العناصر دفعة واحدة (مهم مع نمو عدد الزبائن/المنتجات بمرور الوقت)
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    await page.evaluate(async () => {
      const db = await import('./js/database.js');
      for (let i = 0; i < 65; i++) await db.addCustomer({ name: `زبون ${String(i).padStart(2, '0')}` });
      const d = document.createElement('div'); d.id = 'test-container'; document.body.appendChild(d);
    });
    await page.evaluate(async () => {
      const mod = await import('./js/customers.js');
      await mod.renderCustomerList(document.getElementById('test-container'));
    });
    await page.waitForTimeout(250);

    const firstPage = await page.evaluate(() => document.querySelectorAll('#customer-list-results .list-item').length);
    assert('الصفحة الأولى تعرض 30 عنصرًا فقط من 65', firstPage === 30);

    await page.click('[data-load-more]');
    await page.waitForTimeout(150);
    const secondPage = await page.evaluate(() => document.querySelectorAll('#customer-list-results .list-item').length);
    assert('بعد ضغطة "عرض المزيد" الأولى تعرض 60 عنصرًا', secondPage === 60);

    await page.click('[data-load-more]');
    await page.waitForTimeout(150);
    const afterAll = await page.evaluate(() => ({
      count: document.querySelectorAll('#customer-list-results .list-item').length,
      hasLoadMore: !!document.querySelector('[data-load-more]')
    }));
    assert('بعد الضغطة الثانية تعرض كل الـ65 ويختفي زر "عرض المزيد"', afterAll.count === 65 && !afterAll.hasLoadMore);

    const lastRowClickable = await page.evaluate(() => {
      const rows = document.querySelectorAll('#customer-list-results [data-open]');
      return typeof rows[rows.length - 1].onclick === 'function';
    });
    assert('آخر صف بالدفعة الموسّعة له معالج ضغط مربوط فعليًا', lastRowClickable);
  });
  summary();
})();

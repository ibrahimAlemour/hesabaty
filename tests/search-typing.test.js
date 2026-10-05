// يثبّت إصلاح جذر مشكلة فقدان/تأخّر الأحرف بخانات البحث (راجع renderList بـcustomers.js): الهيكل الثابت
// (مربع البحث) يُبنى مرة واحدة فقط لكل دخول للشاشة، وكل ضغطة تُحدّث فقط منطقة النتائج الفرعية - لا يُعاد
// إنشاء عنصر input نفسه أبدًا بسبب الكتابة. اختُبر هنا بكتابة سريعة جدًا (delay:0) لمحاكاة أسوأ حالة ممكنة.
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page, pageErrors) => {
    await page.evaluate(async () => {
      const db = await import('./js/database.js');
      for (let i = 0; i < 20; i++) await db.addCustomer({ name: `زبون تجريبي ${i}` });
      const d = document.createElement('div'); d.id = 'test-container'; document.body.appendChild(d);
    });
    await page.evaluate(async () => {
      const mod = await import('./js/customers.js');
      await mod.renderCustomerList(document.getElementById('test-container'));
    });
    await page.waitForTimeout(200);

    const typed = 'زبون تجريبي 1';
    await page.click('#customer-search');
    await page.keyboard.type(typed, { delay: 0 });
    await page.waitForTimeout(300);

    const value = await page.evaluate(() => document.getElementById('customer-search').value);
    assert('كل حرف مكتوب يظهر كاملًا بدون فقدان عند الكتابة بأعلى سرعة', value === typed);

    const inputStillSameNode = await page.evaluate(() => {
      const before = document.getElementById('customer-search');
      before.dataset.marker = 'same-node';
      return document.getElementById('customer-search').dataset.marker === 'same-node';
    });
    assert('عنصر input لم يُعَد إنشاؤه (نفس العنصر بعد الكتابة)', inputStillSameNode);

    assert('لا أخطاء جافاسكربت أثناء الكتابة السريعة', pageErrors.length === 0);
  });
  summary();
})();

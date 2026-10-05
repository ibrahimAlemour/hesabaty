// يثبّت شاشة الترحيب (welcome.js + بوّابة التوجيه بـapp.js): تظهر مرة واحدة فقط لأول دخول لصاحب محل
// جديد على هذا الجهاز، لا تظهر أبدًا للكاشير، وتُحفظ محليًا فلا تتكرر بعد إعادة التحميل
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    await page.evaluate(async () => {
      const db = await import('./js/database.js');
      await db.updateSettings({ currentUser: { id: 'u1', name: 'صاحب المحل', role: 'owner' }, welcomeSeen: false });
    });
    await page.reload();
    await page.waitForTimeout(600);

    const first = await page.evaluate(() => ({
      hasBtn: !!document.getElementById('welcome-start-btn'),
      stepsCount: document.querySelectorAll('#app-content .list-item').length
    }));
    assert('شاشة الترحيب تظهر لأول دخول لصاحب محل', first.hasBtn && first.stepsCount === 4);

    await page.click('#welcome-start-btn');
    await page.waitForTimeout(400);
    assert('الضغط على "ابدأ الاستخدام" يخفي شاشة الترحيب', !(await page.evaluate(() => !!document.getElementById('welcome-start-btn'))));

    const flagPersisted = await page.evaluate(async () => (await (await import('./js/database.js')).getSettings()).welcomeSeen);
    assert('علم welcomeSeen يُحفظ محليًا كـtrue', flagPersisted === true);

    await page.reload();
    await page.waitForTimeout(600);
    assert('بعد إعادة التحميل لا تظهر شاشة الترحيب مرة ثانية', !(await page.evaluate(() => !!document.getElementById('welcome-start-btn'))));

    await page.evaluate(async () => {
      const db = await import('./js/database.js');
      await db.updateSettings({ currentUser: { id: 'u2', name: 'كاشير', role: 'cashier' }, welcomeSeen: false });
    });
    await page.reload();
    await page.waitForTimeout(600);
    assert('شاشة الترحيب لا تظهر أبدًا للكاشير حتى لو welcomeSeen=false', !(await page.evaluate(() => !!document.getElementById('welcome-start-btn'))));
  });
  summary();
})();

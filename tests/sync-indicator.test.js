// يثبّت مؤشر حالة المزامنة بالهيدر: تغيّر الحالة (متصل/غير متصل) يُترجم بشكل صحيح للألوان والشيت التوضيحي
// الذي يفتح بالضغط على الأيقونة (لأن title/tooltip لا يظهر باللمس على الجوال)
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    // الشاشة الرئيسية مخفية افتراضيًا قبل تسجيل الدخول - نظهرها قسريًا لفحص أيقونة الهيدر فقط
    await page.evaluate(() => { document.getElementById('app-shell').style.display = 'flex'; });
    await page.waitForTimeout(300);

    const initial = await page.evaluate(() => document.getElementById('sync-status-btn')?.className);
    assert('الحالة الافتراضية (متصل بدون عمليات معلّقة) تضيف صنف sync-synced', (initial || '').includes('sync-synced'));

    await page.click('#sync-status-btn');
    await page.waitForTimeout(250);
    const syncedSheet = await page.evaluate(() => ({
      title: document.querySelector('.confirm-box h3')?.textContent.trim(),
      hasLoginBtn: !!document.querySelector('[data-act="login"]')
    }));
    assert('شيت حالة "متصل" يعرض العنوان الصحيح بدون زر تسجيل دخول', syncedSheet.title === 'متصل ومتزامن' && !syncedSheet.hasLoginBtn);
    await page.click('[data-act="close"]');
    await page.waitForTimeout(250);

    await page.context().setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await page.waitForTimeout(300);
    const offlineClass = await page.evaluate(() => document.getElementById('sync-status-btn').className);
    assert('قطع الاتصال يضيف صنف sync-offline', offlineClass.includes('sync-offline'));
    const offlineColor = await page.evaluate(() => getComputedStyle(document.getElementById('sync-status-btn')).color);
    assert('لون حالة "غير متصل" رمادي هادئ لا أحمر (ليست حالة خطر، بل طبيعية بتطبيق أوفلاين-أولًا)', offlineColor === 'rgb(107, 114, 128)');

    await page.click('#sync-status-btn');
    await page.waitForTimeout(250);
    const offlineSheet = await page.evaluate(() => document.querySelector('.confirm-box h3')?.textContent.trim());
    assert('شيت حالة "غير متصل" يوضّح أنها حالة طبيعية', offlineSheet === 'غير متصل بالإنترنت');
    await page.context().setOffline(false);
  });
  summary();
})();

// يثبّت: إدخال "الإجمالي" يدويًا لمنتج يُباع بالوزن (من الميزان) يبقى ثابتًا بدون انجراف فاصلة عشرية
// بعد أي إعادة رسم للقائمة (كإضافة منتج آخر) - كان يحدث انجراف بسبب تقريب الكمية المشتقة (وزن)
// إلى 3 خانات عشرية قبل حفظها بالحالة، فتُعيد الحسابات اللاحقة حسابًا مختلفًا قليلًا (سعر × كمية مُقرَّبة)
// بدل الإجمالي الفعلي المُدخَل. الإصلاح: نحتفظ بكامل دقة الكمية بالحالة، ونقرّبها فقط للعرض بحقل الوزن.
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

    // منتج أول: نُدخل الإجمالي يدويًا (سعر 11 ₪/كغ، إجمالي 1.70 ₪ من الميزان - هذا التركيب تحديدًا يُنتج وزنًا
    // "0.155" عند تقريبه لـ3 خانات عشرية، وإعادة حساب 11×0.155 تُعطي 1.71 لا 1.70 إن لم نحتفظ بكامل الدقة)
    await page.click('#search-product-btn');
    await page.waitForTimeout(150);
    await page.click('#manual-product-btn');
    await page.waitForTimeout(150);
    await page.fill('#mp-name', 'صدر دجاج');
    await page.fill('#mp-price', '11');
    await page.click('#mp-add');
    await page.waitForTimeout(150);

    await page.fill('.item-total[data-idx="0"]', '1.70');
    await page.waitForTimeout(100);

    const totalBeforeSecondItem = await page.evaluate(() => document.querySelector('.item-total[data-idx="0"]').value);
    assert('الإجمالي المُدخَل يدويًا يظهر كما هو فور الكتابة (1.7)', parseFloat(totalBeforeSecondItem) === 1.7);

    // إضافة منتج ثانٍ: هذا يُعيد رسم القائمة كاملة (refreshItemsAndTotals) - هنا كان الانجراف يظهر سابقًا
    await page.click('#search-product-btn');
    await page.waitForTimeout(150);
    await page.click('#manual-product-btn');
    await page.waitForTimeout(150);
    await page.fill('#mp-name', 'فخد دجاج');
    await page.fill('#mp-price', '22');
    await page.click('#mp-add');
    await page.waitForTimeout(150);

    const totalAfterSecondItem = await page.evaluate(() => document.querySelector('.item-total[data-idx="0"]').value);
    assert('إجمالي المنتج الأول يبقى 1.7 بالضبط بعد إضافة منتج ثانٍ (لا انجراف)', parseFloat(totalAfterSecondItem) === 1.7);

    // إضافة منتج ثالث: نتأكد أن التكرار لا يُراكم انجرافًا إضافيًا
    await page.click('#search-product-btn');
    await page.waitForTimeout(150);
    await page.click('#manual-product-btn');
    await page.waitForTimeout(150);
    await page.fill('#mp-name', 'كبدة دجاج');
    await page.fill('#mp-price', '18');
    await page.click('#mp-add');
    await page.waitForTimeout(150);

    const totalAfterThirdItem = await page.evaluate(() => document.querySelector('.item-total[data-idx="0"]').value);
    assert('إجمالي المنتج الأول يبقى 1.7 بالضبط حتى بعد إضافة منتج ثالث', parseFloat(totalAfterThirdItem) === 1.7);

    // إكمال البيع والتحقق أن المبلغ المحفوظ فعليًا بقاعدة البيانات مطابق تمامًا لما ظهر بالشاشة (170 فلس = 1.70 ₪)
    await page.fill('.item-total[data-idx="1"]', '15');
    await page.fill('.item-total[data-idx="2"]', '9');
    await page.waitForTimeout(100);
    await page.click('#complete-sale-btn');
    await page.waitForTimeout(400);

    const savedItems = await page.evaluate(async () => {
      const db = await import('./js/database.js');
      const sales = await db.getSales({});
      const sale = sales.find(s => s.notes === '' || true); // آخر بيع (الوحيد هنا)
      return (await db.getSaleItems(sale.id)).map(it => ({ name: it.product_name, total_price: it.total_price }));
    });
    const chickenBreast = savedItems.find(it => it.name === 'صدر دجاج');
    assert('إجمالي المنتج الأول المحفوظ بقاعدة البيانات = 170 فلسًا (1.70 ₪) بالضبط', chickenBreast.total_price === 170);
  });
  summary();
})();

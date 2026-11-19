// يثبّت ميزة "كشوف الزبائن" الجديدة (أيقونة الطباعة بشاشة قائمة الزبائن + الأنواع الثلاثة):
// جلب كل الزبائن من قاعدة البيانات مباشرة (لا من القائمة المعروضة فقط)، تصنيف مدين/دائن بنفس منطق
// الرصيد المعتمد بباقي التطبيق، استبعاد الرصيد صفر من كشفي المدينين/الدائنين، والإجماليات الصحيحة.
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    const ids = await page.evaluate(async () => {
      const db = await import('./js/database.js');
      await db.updateSettings({ backendMode: 'local', setupCompleted: true, currentUser: { id: 'u1', name: 'المالك', role: 'owner' }, shopName: 'محل الاختبار' });
      sessionStorage.setItem('hesabaty_session', 'u1');

      // زبون مدين (عليه 150)
      const debtor1 = await db.addCustomer({ name: 'زبون مدين أول', phone: '0599111111' });
      await db.createSale({ items: [{ product_id: null, product_name: 'منتج', unit: 'قطعة', quantity: 1, selling_price: '150', cost_price: '0' }], paidDebt: 150, customerId: debtor1.id, customerName: debtor1.name, notes: '' });

      // زبون مدين ثانٍ (عليه 50)
      const debtor2 = await db.addCustomer({ name: 'زبون مدين ثانٍ', phone: '0599222222' });
      await db.createSale({ items: [{ product_id: null, product_name: 'منتج', unit: 'قطعة', quantity: 1, selling_price: '50', cost_price: '0' }], paidDebt: 50, customerId: debtor2.id, customerName: debtor2.name, notes: '' });

      // زبون دائن (دفع أكثر من المطلوب: دين 20 ثم دفعة 50 - رصيد -30)
      const creditor1 = await db.addCustomer({ name: 'زبون دائن', phone: '0599333333' });
      await db.createSale({ items: [{ product_id: null, product_name: 'منتج', unit: 'قطعة', quantity: 1, selling_price: '20', cost_price: '0' }], paidDebt: 20, customerId: creditor1.id, customerName: creditor1.name, notes: '' });
      await db.addPayment({ customerId: creditor1.id, amount: 50, method: 'cash', notes: '' });

      // زبون برصيد صفر (يُستبعد من كشفي المدينين/الدائنين، لكن يظهر بكشف "الكل")
      const zeroBalance = await db.addCustomer({ name: 'زبون رصيد صفر', phone: '0599444444' });

      // 30 زبونًا إضافيًا بلا أي حركات (لاختبار جلب عدد كبير من السجلات دفعة واحدة دون نقص)
      for (let i = 0; i < 30; i++) await db.addCustomer({ name: `زبون رقم ${i + 1}`, phone: '' });

      const d = document.createElement('div'); d.id = 'test-container'; document.body.appendChild(d);
      return { debtor1: debtor1.id, debtor2: debtor2.id, creditor1: creditor1.id, zeroBalance: zeroBalance.id };
    });

    const totalCustomersCount = await page.evaluate(async () => (await (await import('./js/database.js')).getCustomers()).length);
    assert('تمهيد: 34 زبونًا بقاعدة البيانات (3 مدينون/دائن + صفر + 30 بلا حركات)', totalCustomersCount === 34);

    // ========== أيقونة الطباعة: تظهر فقط بشاشة قائمة الزبائن وتفتح نافذة الخيارات ==========
    await page.evaluate(() => { window.location.hash = '#/customers'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
    await page.waitForTimeout(500);
    const printBtnVisible = await page.evaluate(() => getComputedStyle(document.getElementById('customers-print-btn')).display !== 'none');
    assert('أيقونة طباعة كشوف الزبائن تظهر بشاشة قائمة الزبائن', printBtnVisible);

    await page.click('#customers-print-btn');
    await page.waitForTimeout(200);
    const optionsCount = await page.evaluate(() => document.querySelectorAll('.sheet [data-report-type]').length);
    assert('نافذة الخيارات تعرض 3 أنواع كشوف', optionsCount === 3);

    // ========== كشف جميع الزبائن ==========
    await page.click('.sheet [data-report-type="all"]');
    await page.waitForTimeout(300);
    const hashAll = await page.evaluate(() => window.location.hash);
    assert('اختيار "كشف جميع الزبائن" ينقل لـ#/customers/report/all', hashAll === '#/customers/report/all');

    await page.evaluate(async () => {
      const mod = await import('./js/customers.js');
      await mod.renderCustomersReport(document.getElementById('test-container'), 'all');
    });
    await page.waitForTimeout(250);
    const allRowCount = await page.evaluate(() => document.getElementById('test-container').querySelectorAll('.stmt-table tbody tr').length);
    assert('كشف "الكل": يعرض كل الـ34 زبونًا دون نقص ولا تكرار (يشمل الرصيد صفر)', allRowCount === 34);

    const allTexts = await page.evaluate(() => document.getElementById('test-container').textContent);
    assert('كشف "الكل" يحتوي اسم المحل بالرأس', allTexts.includes('محل الاختبار'));
    assert('كشف "الكل": إجمالي عدد الزبائن = 34', allTexts.includes('34'));

    // ========== كشف الزبائن المدينين ==========
    await page.evaluate(async () => {
      const mod = await import('./js/customers.js');
      await mod.renderCustomersReport(document.getElementById('test-container'), 'debtors');
    });
    await page.waitForTimeout(250);
    const debtorRows = await page.evaluate(() => Array.from(document.getElementById('test-container').querySelectorAll('.stmt-table tbody tr')).map(tr => tr.textContent));
    assert('كشف المدينين: صفّان فقط (المدينان، لا الدائن ولا الصفر ولا الـ30 بلا حركات)', debtorRows.length === 2);
    assert('كشف المدينين يحتوي الزبون المدين الأول باسمه ومبلغه (150.00)', debtorRows.some(t => t.includes('زبون مدين أول') && t.includes('150.00')));
    assert('كشف المدينين يحتوي الزبون المدين الثاني باسمه ومبلغه (50.00)', debtorRows.some(t => t.includes('زبون مدين ثانٍ') && t.includes('50.00')));
    assert('كشف المدينين لا يحتوي الزبون الدائن', !debtorRows.some(t => t.includes('زبون دائن')));
    assert('كشف المدينين لا يحتوي زبون الرصيد صفر', !debtorRows.some(t => t.includes('زبون رصيد صفر')));
    const debtorsSummary = await page.evaluate(() => document.getElementById('test-container').textContent);
    assert('كشف المدينين: إجمالي المستحق = 200.00 (150+50)', debtorsSummary.includes('200.00'));

    // ========== كشف الزبائن الدائنين ==========
    await page.evaluate(async () => {
      const mod = await import('./js/customers.js');
      await mod.renderCustomersReport(document.getElementById('test-container'), 'creditors');
    });
    await page.waitForTimeout(250);
    const creditorRows = await page.evaluate(() => Array.from(document.getElementById('test-container').querySelectorAll('.stmt-table tbody tr')).map(tr => tr.textContent));
    assert('كشف الدائنين: صف واحد فقط (الزبون الدائن)', creditorRows.length === 1);
    assert('كشف الدائنين يحتوي الزبون الدائن برصيده الصحيح (30.00)', creditorRows[0].includes('زبون دائن') && creditorRows[0].includes('30.00'));

    // ========== أزرار التحكم: رجوع/إغلاق ==========
    const hasBackBtn = await page.evaluate(() => !!document.getElementById('cr-back'));
    const hasCloseBtn = await page.evaluate(() => !!document.getElementById('cr-close'));
    const hasPrintBtn = await page.evaluate(() => !!document.getElementById('cr-print'));
    const hasPdfBtn = await page.evaluate(() => !!document.getElementById('cr-pdf'));
    assert('أزرار التحكم الأربعة كلها موجودة (طباعة/PDF/رجوع/إغلاق)', hasBackBtn && hasCloseBtn && hasPrintBtn && hasPdfBtn);

    await page.click('#cr-back');
    await page.waitForTimeout(200);
    const backOpensSheet = await page.evaluate(() => document.querySelectorAll('.sheet [data-report-type]').length === 3);
    assert('زر "تغيير نوع الكشف" يعيد فتح نافذة الخيارات', backOpensSheet);
  });
  summary();
})();

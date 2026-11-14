// يثبّت: شيت "إضافة دين" (مبلغ مباشر بدون منتجات) بحساب الزبون يدعم تاريخًا يدويًا للدين. addManualDebtCharge()
// الخلفية كانت تدعم createdAt مسبقًا - هذا يثبّت أن الواجهة صارت تعرضه وتُمرِّره فعليًا بشكل صحيح.
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    const customerId = await page.evaluate(async () => {
      const db = await import('./js/database.js');
      await db.updateSettings({ backendMode: 'local', currentUser: { id: 'u1', name: 'المالك', role: 'owner' } });
      const customer = await db.addCustomer({ name: 'زبون الاختبار' });
      const d = document.createElement('div'); d.id = 'test-container'; document.body.appendChild(d);
      return customer.id;
    });

    await page.evaluate(async (id) => {
      const mod = await import('./js/customers.js');
      await mod.renderCustomerDetail(document.getElementById('test-container'), id);
    }, customerId);
    await page.waitForTimeout(250);
    await page.click('#add-charge-btn');
    await page.waitForTimeout(250);

    const hasDateInput = await page.evaluate(() => !!document.getElementById('charge-date'));
    assert('شيت إضافة الدين: يوجد حقل تاريخ', hasDateInput);
    const dateDefaultsToday = await page.evaluate(() => document.getElementById('charge-date').value === new Date().toISOString().slice(0, 10));
    assert('حقل تاريخ إضافة الدين يبدأ باليوم الحالي افتراضيًا', dateDefaultsToday);

    await page.fill('#charge-amount', '75');
    await page.fill('#charge-date', '2026-03-10');
    await page.click('#charge-save');
    await page.waitForTimeout(350);

    const savedDebt = await page.evaluate(async (id) => {
      const db = await import('./js/database.js');
      return (await db.getSales({ customerId: id }))[0];
    }, customerId);
    assert('تاريخ الدين المُدخَل يدويًا يُحفَظ بشكل صحيح', savedDebt.created_at.startsWith('2026-03-10'));
    assert('المبلغ المحفوظ صحيح', savedDebt.paid_debt === 7500);
  });
  summary();
})();

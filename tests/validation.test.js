// يثبّت إصلاحات التحقق المالي: رفض المبالغ السالبة بالبيع والشراء، والتحقق من رقم الجوال (10 أرقام تمامًا)
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    const result = await page.evaluate(async () => {
      const db = await import('./js/database.js');
      const utils = await import('./js/utils.js');

      const p = await db.addProduct({ name: 'منتج اختبار', unit: 'قطعة', selling_price: '10', cost_price: '5' });

      let saleRejectedNegativeCash = false;
      try {
        await db.createSale({
          items: [{ product_id: p.id, product_name: p.name, unit: p.unit, quantity: 1, selling_price: '10', cost_price: '5' }],
          paidCash: -10, notes: ''
        });
      } catch (e) { saleRejectedNegativeCash = true; }

      let purchaseRejectedNegativeCash = false;
      const sup = await db.addSupplier({ name: 'مورد اختبار' });
      try {
        await db.addPurchase({
          items: [{ product_id: p.id, product_name: p.name, unit: p.unit, quantity: 1, purchase_price: '5' }],
          paidCash: -5, supplierId: sup.id, supplierName: sup.name
        });
      } catch (e) { purchaseRejectedNegativeCash = true; }

      return {
        saleRejectedNegativeCash,
        purchaseRejectedNegativeCash,
        phoneValidEmpty: utils.isValidPhone(''),
        phoneValid10Digits: utils.isValidPhone('0599123456'),
        phoneRejected9Digits: !utils.isValidPhone('059912345'),
        phoneRejected11Digits: !utils.isValidPhone('05991234567'),
        phoneRejectedLetters: !utils.isValidPhone('05991abcde')
      };
    });

    assert('بيع بمبلغ نقدي سالب يُرفض', result.saleRejectedNegativeCash);
    assert('شراء بمبلغ نقدي سالب يُرفض', result.purchaseRejectedNegativeCash);
    assert('رقم جوال فارغ مقبول (حقل اختياري)', result.phoneValidEmpty);
    assert('رقم جوال من 10 أرقام مقبول', result.phoneValid10Digits);
    assert('رقم جوال أقل من 10 أرقام مرفوض', result.phoneRejected9Digits);
    assert('رقم جوال أكثر من 10 أرقام مرفوض', result.phoneRejected11Digits);
    assert('رقم جوال يحتوي أحرفًا مرفوض', result.phoneRejectedLetters);
  });
  summary();
})();

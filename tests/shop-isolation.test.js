// يثبّت إصلاح أمني حرج: سجل محلي (IndexedDB) من محل آخر عالق على نفس الجهاز (بقايا تبديل محل سابق لم
// يُمسح لأي سبب) كان يظهر للأبد بجانب بيانات المحل الحالي دون أي تنبيه، لأن القراءات المحلية (getSuppliers،
// getCustomers، getProducts...) لم تكن تفلتر بـshop_id إطلاقًا - اعتمادًا كليًا على نجاح مسح البيانات عند
// تبديل الحساب (clearLocalBusinessData)، بدون أي حاجز حماية ثانٍ. حالة حقيقية حصلت فعليًا: مورد تابع لمحل
// "Super Market lb" ظهر بحساب محل مختلف تمامًا ("شيخ العيد للخضار والفواكه"). الإصلاح: localGetAll() بـ
// database.js يفلتر أي سجل محلي shop_id فيه لا يطابق المحل الحالي، بغض النظر عن كيفية وصوله محليًا.
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    const result = await page.evaluate(async () => {
      const db = await import('./js/database.js');
      const idb = await import('./js/db-indexeddb.js');

      await db.updateSettings({ backendMode: 'supabase', currentShopId: 'shop-a', currentUser: { id: 'u1', name: 'مالك', role: 'owner' } });

      const goodSupplier = await db.addSupplier({ name: 'مورد المحل الصحيح' });
      const goodCustomer = await db.addCustomer({ name: 'زبون المحل الصحيح' });
      const goodProduct = await db.addProduct({ name: 'منتج المحل الصحيح', unit: 'قطعة', selling_price: '5', cost_price: '3' });

      // سجلات "ملوّثة" shop_id فيها يخص محلًا مختلفًا تمامًا - كما لو وصلت من سحب سابق لمحل آخر على نفس الجهاز
      await idb.put('suppliers', { id: 'bad-sup', name: 'مورد محل آخر', shop_id: 'shop-b', is_deleted: false, created_at: new Date().toISOString() });
      await idb.put('customers', { id: 'bad-cust', name: 'زبون محل آخر', shop_id: 'shop-b', is_deleted: false, created_at: new Date().toISOString() });
      await idb.put('products', { id: 'bad-prod', name: 'منتج محل آخر', shop_id: 'shop-b', is_active: true, created_at: new Date().toISOString() });

      const suppliers = await db.getSuppliers();
      const customers = await db.getCustomers();
      const products = await db.getProducts();

      return {
        supplierNames: suppliers.map((s) => s.name),
        customerNames: customers.map((c) => c.name),
        productNames: products.map((p) => p.name),
        goodSupplierPresent: suppliers.some((s) => s.id === goodSupplier.id),
        goodCustomerPresent: customers.some((c) => c.id === goodCustomer.id),
        goodProductPresent: products.some((p) => p.id === goodProduct.id)
      };
    });

    assert('مورد المحل الصحيح ما زال ظاهرًا', result.goodSupplierPresent);
    assert('زبون المحل الصحيح ما زال ظاهرًا', result.goodCustomerPresent);
    assert('منتج المحل الصحيح ما زال ظاهرًا', result.goodProductPresent);
    assert('مورد المحل الآخر لا يظهر إطلاقًا', !result.supplierNames.includes('مورد محل آخر'));
    assert('زبون المحل الآخر لا يظهر إطلاقًا', !result.customerNames.includes('زبون محل آخر'));
    assert('منتج المحل الآخر لا يظهر إطلاقًا', !result.productNames.includes('منتج محل آخر'));
  });
  summary();
})();

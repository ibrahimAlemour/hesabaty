// يثبّت: تسجيل دفعة لمورد يدعم تاريخًا يدويًا واختيار فاتورة محدَّدة (فقط لو عنده أكثر من فاتورة غير مسدَّدة
// بالكامل)، وتسجيل دفعة لزبون يدعم تاريخًا يدويًا. الدالتان الخلفيتان (addSupplierPayment/addPayment) كانتا
// تدعمان createdAt/purchaseId مسبقًا - هذا يثبّت أن الواجهة صارت تعرضهما وتُمرِّرهما فعليًا بشكل صحيح.
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    const ids = await page.evaluate(async () => {
      const db = await import('./js/database.js');
      await db.updateSettings({ backendMode: 'local', currentUser: { id: 'u1', name: 'المالك', role: 'owner' } });

      const supplier = await db.addSupplier({ name: 'مورد الاختبار' });
      const { purchase: p1 } = await db.addPurchase({
        supplierId: supplier.id, supplierName: supplier.name, supplierInvoiceNumber: '', purchaseDate: new Date().toISOString(),
        items: [{ product_id: null, product_name: 'منتج1', unit: 'قطعة', quantity: 1, purchase_price: '100' }],
        paidCash: 0, paidTransfer: 0, paidCredit: 100, discount: 0, extraCosts: 0, notes: ''
      });
      const { purchase: p2 } = await db.addPurchase({
        supplierId: supplier.id, supplierName: supplier.name, supplierInvoiceNumber: '', purchaseDate: new Date().toISOString(),
        items: [{ product_id: null, product_name: 'منتج2', unit: 'قطعة', quantity: 1, purchase_price: '200' }],
        paidCash: 0, paidTransfer: 0, paidCredit: 200, discount: 0, extraCosts: 0, notes: ''
      });

      const supplierOneInvoice = await db.addSupplier({ name: 'مورد بفاتورة واحدة' });
      await db.addPurchase({
        supplierId: supplierOneInvoice.id, supplierName: supplierOneInvoice.name, supplierInvoiceNumber: '', purchaseDate: new Date().toISOString(),
        items: [{ product_id: null, product_name: 'منتج', unit: 'قطعة', quantity: 1, purchase_price: '50' }],
        paidCash: 0, paidTransfer: 0, paidCredit: 50, discount: 0, extraCosts: 0, notes: ''
      });

      const customer = await db.addCustomer({ name: 'زبون الاختبار' });
      await db.createSale({
        items: [{ product_id: null, product_name: 'منتج', unit: 'قطعة', quantity: 1, selling_price: '500', cost_price: '0' }],
        paidDebt: 500, customerId: customer.id, customerName: customer.name, notes: ''
      });

      const d = document.createElement('div'); d.id = 'test-container'; document.body.appendChild(d);
      return { supplierId: supplier.id, supplierOneInvoiceId: supplierOneInvoice.id, customerId: customer.id, p1Id: p1.id, p2Id: p2.id };
    });

    // ========== مورد بفاتورتين غير مسدَّدتين: يجب أن يظهر اختيار الفاتورة ==========
    await page.evaluate(async (supplierId) => {
      const mod = await import('./js/suppliers.js');
      await mod.renderSupplierDetail(document.getElementById('test-container'), supplierId);
    }, ids.supplierId);
    await page.waitForTimeout(250);
    await page.click('#record-payment-btn');
    await page.waitForTimeout(250);

    const hasDateInput = await page.evaluate(() => !!document.getElementById('sp-date'));
    assert('شاشة دفعة المورد: يوجد حقل تاريخ', hasDateInput);
    const dateDefaultsToday = await page.evaluate(() => document.getElementById('sp-date').value === new Date().toISOString().slice(0, 10));
    assert('حقل تاريخ دفعة المورد يبدأ باليوم الحالي افتراضيًا', dateDefaultsToday);

    const purchaseSelectOptions = await page.evaluate(() => document.querySelectorAll('#sp-purchase option').length);
    assert('قائمة اختيار الفاتورة تظهر (فاتورتان غير مسدَّدتين) بثلاثة خيارات (غير محدد + فاتورتان)', purchaseSelectOptions === 3);

    await page.fill('#sp-amount', '100');
    await page.selectOption('#sp-purchase', { index: 1 }); // أول فاتورة بالقائمة (بعد "غير محدد")
    await page.fill('#sp-date', '2026-01-15');
    const beforeSpSave = Date.now();
    await page.click('#sp-save');
    await page.waitForTimeout(350);
    const afterSpSave = Date.now();

    const savedSupplierPayment = await page.evaluate(async (supplierId) => {
      const db = await import('./js/database.js');
      return (await db.getSupplierPayments({ supplierId }))[0];
    }, ids.supplierId);
    assert('تاريخ دفعة المورد المُدخَل يدويًا يُحفَظ بشكل صحيح', savedSupplierPayment.created_at.startsWith('2026-01-15'));
    // الوقت المحفوظ يجب أن يطابق الوقت الفعلي الآن (وليس منتصف الليل UTC) - هذا يثبّت إصلاح باق توقيت "2 صباحًا"
    const savedTimeOfDayMs = (() => {
      const d = new Date(savedSupplierPayment.created_at);
      return ((d.getUTCHours() * 60 + d.getUTCMinutes()) * 60 + d.getUTCSeconds()) * 1000;
    })();
    const nowTimeOfDayRange = [beforeSpSave, afterSpSave].map(ms => {
      const d = new Date(ms);
      return ((d.getUTCHours() * 60 + d.getUTCMinutes()) * 60 + d.getUTCSeconds()) * 1000;
    });
    assert('وقت دفعة المورد المحفوظ يطابق الوقت الفعلي الآن (ليس منتصف الليل)', savedTimeOfDayMs >= nowTimeOfDayRange[0] - 5000 && savedTimeOfDayMs <= nowTimeOfDayRange[1] + 5000);
    assert('الفاتورة المختارة تُربَط فعليًا بالدفعة (purchase_id غير فارغ)', !!savedSupplierPayment.purchase_id);
    assert('الفاتورة المرتبطة هي إحدى الفاتورتين الفعليتين', [ids.p1Id, ids.p2Id].includes(savedSupplierPayment.purchase_id));

    // ========== مورد بفاتورة واحدة فقط: يجب ألا تظهر قائمة اختيار الفاتورة ==========
    await page.evaluate(async (supplierId) => {
      const mod = await import('./js/suppliers.js');
      await mod.renderSupplierDetail(document.getElementById('test-container'), supplierId);
    }, ids.supplierOneInvoiceId);
    await page.waitForTimeout(250);
    await page.click('#record-payment-btn');
    await page.waitForTimeout(250);
    const noSelectForSingleInvoice = await page.evaluate(() => !document.getElementById('sp-purchase'));
    assert('مورد بفاتورة واحدة فقط: لا تظهر قائمة اختيار (لا داعي لها)', noSelectForSingleInvoice);
    await page.evaluate(async () => (await import('./js/ui.js')).closeSheet());
    await page.waitForTimeout(150);

    // ========== شاشة الزبون: تاريخ يدوي فقط (بدون اختيار فاتورة) ==========
    await page.evaluate(async (customerId) => {
      const mod = await import('./js/customers.js');
      await mod.renderCustomerDetail(document.getElementById('test-container'), customerId);
    }, ids.customerId);
    await page.waitForTimeout(250);
    await page.click('#record-payment-btn');
    await page.waitForTimeout(250);

    const hasCustDateInput = await page.evaluate(() => !!document.getElementById('pay-date'));
    assert('شاشة دفعة الزبون: يوجد حقل تاريخ', hasCustDateInput);

    await page.fill('#pay-amount', '200');
    await page.fill('#pay-date', '2026-02-20');
    const beforePaySave = Date.now();
    await page.click('#pay-save');
    await page.waitForTimeout(350);
    const afterPaySave = Date.now();

    const savedCustPayment = await page.evaluate(async (customerId) => {
      const db = await import('./js/database.js');
      return (await db.getPayments({ customerId }))[0];
    }, ids.customerId);
    assert('تاريخ دفعة الزبون المُدخَل يدويًا يُحفَظ بشكل صحيح', savedCustPayment.created_at.startsWith('2026-02-20'));
    const custSavedTimeOfDayMs = (() => {
      const d = new Date(savedCustPayment.created_at);
      return ((d.getUTCHours() * 60 + d.getUTCMinutes()) * 60 + d.getUTCSeconds()) * 1000;
    })();
    const custNowTimeOfDayRange = [beforePaySave, afterPaySave].map(ms => {
      const d = new Date(ms);
      return ((d.getUTCHours() * 60 + d.getUTCMinutes()) * 60 + d.getUTCSeconds()) * 1000;
    });
    assert('وقت دفعة الزبون المحفوظ يطابق الوقت الفعلي الآن (ليس منتصف الليل)', custSavedTimeOfDayMs >= custNowTimeOfDayRange[0] - 5000 && custSavedTimeOfDayMs <= custNowTimeOfDayRange[1] + 5000);
  });
  summary();
})();

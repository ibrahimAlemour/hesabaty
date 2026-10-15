// يثبّت سلامة دورة حياة كاملة: ديون تُسجَّل أثناء انقطاع حقيقي بالاتصال (page.context().setOffline، لا مجرد
// محاكاة navigator.onLine) → تحديث الصفحة قبل عودة الاتصال (العمليات المعلّقة يجب ألا تُفقد - محفوظة فعليًا
// بـIndexedDB) → عودة الاتصال ومزامنة الكل → محاكاة تحديث صفحة أخير (pullFromRemote) والتأكد من بقاء كل
// الديون العشرة بلا فقدان ولا تكرار. يغطي هذا مباشرة سيناريو "انقطاع الإنترنت أثناء تسجيل الديون" الذي
// أبلغ عنه المستخدم (راجع أيضًا sync-race.test.js لحالة التسابق المحدَّدة بين flushQueue وpullFromRemote).
const { withPage, assert, summary } = require('./_harness');

function registerMock(remoteSales) {
  function makeBuilder(table) {
    let mode = 'select', payload = null;
    const self = {
      select() { return self; }, eq() { return self; }, maybeSingle() { return resolve(); },
      range() { return self; }, // دعم ترقيم الصفحات الذي أضافته db-supabase.js (إصلاح حد الـ1000 صف الافتراضي)
      delete() { mode = 'delete'; return self; },
      upsert(p) { mode = 'upsert'; payload = p; return resolve(); },
      then(res, rej) { resolve().then(res, rej); }
    };
    async function resolve() {
      if (table === 'sales' && mode === 'select') return { data: [...remoteSales], error: null };
      if (table === 'sales' && mode === 'upsert') {
        const rec = Array.isArray(payload) ? payload[0] : payload;
        const i = remoteSales.findIndex((r) => r.id === rec.id);
        if (i >= 0) remoteSales[i] = rec; else remoteSales.push(rec);
        return { error: null };
      }
      if (mode === 'delete') return { error: null };
      return { data: [], error: null };
    }
    return self;
  }
  window.supabase = {
    createClient: () => ({
      from: (t) => makeBuilder(t),
      auth: {
        getSession: async () => ({ data: { session: { expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1' } } } }),
        getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }),
        refreshSession: async () => ({ data: { session: { expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
      }
    })
  };
}

(async () => {
  await withPage(async (page) => {
    await page.evaluate((fn) => eval(`(${fn})`)(window.__remoteSales = []), registerMock.toString());

    const { customerId } = await page.evaluate(async () => {
      const dbSupabase = await import('./js/db-supabase.js');
      await dbSupabase.initSupabaseClient({ url: 'https://fake.supabase.co', anonKey: 'fake' });
      const db = await import('./js/database.js');
      await db.updateSettings({ backendMode: 'supabase', currentShopId: 'shop-1', currentUser: { id: 'u1', name: 'مالك', role: 'owner' } });
      const customer = await db.addCustomer({ name: 'زبون اختبار الأوفلاين' });
      return { customerId: customer.id };
    });

    // 1) قطع اتصال حقيقي + تسجيل 10 ديون متتالية
    await page.context().setOffline(true);
    const saleIds = await page.evaluate(async (customerId) => {
      const db = await import('./js/database.js');
      const ids = [];
      for (let i = 0; i < 10; i++) {
        const { sale } = await db.createSale({
          items: [{ product_id: null, product_name: `دين ${i}`, unit: 'خدمة', quantity: 1, selling_price: '50', cost_price: '0' }],
          paidDebt: 50, customerId, customerName: 'زبون اختبار الأوفلاين', notes: ''
        });
        ids.push(sale.id);
      }
      return ids;
    }, customerId);

    const whileOffline = await page.evaluate(async () => {
      const db = await import('./js/database.js');
      const sync = await import('./js/sync.js');
      const localSales = await db.getSales();
      const pending = await sync.getPendingItems();
      return { localCount: localSales.length, pendingSalesCount: pending.filter((p) => p.storeName === 'sales').length };
    });
    assert('أثناء الانقطاع: كل العشر ديون محفوظة محليًا', whileOffline.localCount === 10);
    assert('أثناء الانقطاع: كل العشرة بانتظار الرفع بالطابور', whileOffline.pendingSalesCount === 10);

    // 2) تحديث الصفحة *قبل* عودة الاتصال - العمليات المعلّقة يجب ألا تُفقد
    await page.reload();
    await page.waitForTimeout(300);
    const afterReloadStillOffline = await page.evaluate(async () => {
      const db = await import('./js/database.js');
      const sync = await import('./js/sync.js');
      const localSales = await db.getSales();
      const pending = await sync.getPendingItems();
      return { localCount: localSales.length, pendingSalesCount: pending.filter((p) => p.storeName === 'sales').length };
    });
    assert('بعد تحديث الصفحة أثناء الانقطاع: الديون العشر لم تُفقد محليًا', afterReloadStillOffline.localCount === 10);
    assert('بعد تحديث الصفحة أثناء الانقطاع: العشرة ما زالت بانتظار الرفع (لم تُفقد من الطابور)', afterReloadStillOffline.pendingSalesCount === 10);

    // 3) عودة الاتصال + مزامنة كل العمليات المعلّقة. هذا الاختبار يحمّل index.html كاملة (لا وحدات معزولة)،
    // وapp.js الحقيقي يستدعي initAutoSync() عند تحميله (مسجَّل بالفعل منذ إعادة التحميل بالخطوة 2) - أي أن
    // مستمع 'online' الحقيقي بالتطبيق نفسه موجود فعلًا وسيُطلِق flushQueue() تلقائيًا بمجرد عودة الاتصال، تمامًا
    // كما يحصل بالاستخدام الفعلي. لا نستدعي flushQueue() يدويًا هنا: استدعاء إضافي صريح كان يتسابق فعليًا مع
    // هذا المستمع التلقائي (كلاهما يحاول العمل بنفس اللحظة) ويُسبّب قياسًا غير مكتمل - نكتفي بإعادة تسجيل الموك
    // ثم الانتظار الفعلي لاكتمال التفريغ، تمامًا كما يختبر مستخدم حقيقي استعادة الاتصال دون تدخل يدوي
    await page.evaluate((fn) => eval(`(${fn})`)(window.__remoteSales = []), registerMock.toString());
    await page.evaluate(async () => {
      const dbSupabase = await import('./js/db-supabase.js');
      await dbSupabase.initSupabaseClient({ url: 'https://fake.supabase.co', anonKey: 'fake' });
    });
    await page.context().setOffline(false);
    // استطلاع صريح من جانب Node (لا page.waitForFunction - لوحظ أنه قد "يرضى" بحالة عابرة لا تعكس فعليًا
    // اكتمال التفريغ هنا) لخلو الطابور بالكامل (كل الأنواع)، كل 100ms حتى اكتمال فعلي أو انتهاء المهلة
    for (let waited = 0; waited < 15000; waited += 100) {
      const count = await page.evaluate(async () => (await (await import('./js/sync.js')).getPendingItems()).length);
      if (count === 0) break;
      await page.waitForTimeout(100);
    }
    const afterSync = await page.evaluate(async () => {
      const sync = await import('./js/sync.js');
      const pending = await sync.getPendingItems();
      return { remoteCount: window.__remoteSales.length, pendingSalesCount: pending.filter((p) => p.storeName === 'sales').length };
    });
    assert('بعد عودة الاتصال: كل العشر ديون وصلت لقاعدة البيانات', afterSync.remoteCount === 10);
    assert('بعد عودة الاتصال: طابور الانتظار فارغ تمامًا', afterSync.pendingSalesCount === 0);

    // 4) محاكاة تحديث صفحة أخير (pullFromRemote) - الديون العشر يجب أن تبقى كما هي، بلا فقدان ولا تكرار
    const afterPull = await page.evaluate(async (ids) => {
      const db = await import('./js/database.js');
      await db.pullFromRemote();
      const localSales = await db.getSales();
      return { totalLocal: localSales.length, matchedOfTen: ids.filter((id) => localSales.some((s) => s.id === id)).length };
    }, saleIds);
    assert('بعد pullFromRemote الأخير: لا تكرار (العدد الكلي محليًا = 10 بالضبط)', afterPull.totalLocal === 10);
    assert('بعد pullFromRemote الأخير: كل العشرة الأصلية موجودة (لا فقدان)', afterPull.matchedOfTen === 10);
  });
  summary();
})();

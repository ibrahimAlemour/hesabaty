// يثبّت: لو فشلت عملية واحدة ضمن عدة عمليات بانتظار المزامنة، يجب ألا تُعتبر المزامنة "ناجحة بالكامل" -
// يبقى العدد الصحيح من العمليات معلّقًا، ولا تظهر رسالة "تمت مزامنة جميع العمليات" (راجع flushQueue بـsync.js:
// toastSuccess لا يُستدعى إلا عندما remaining === 0 فعليًا). كما يتحقق أن الترتيب يُحفظ (نتوقف عند أول فشل
// فلا تُعالَج عملية لاحقة قبل سابقتها الفاشلة - "لا تختل الحركات").
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    const result = await page.evaluate(async () => {
      let failOnSecondSale = true;
      const remoteSales = [];
      const processedOrder = [];

      function makeBuilder(table) {
        let mode = 'select', payload = null;
        const self = {
          select() { return self; }, eq() { return self; }, maybeSingle() { return resolve(); },
          delete() { mode = 'delete'; return self; },
          upsert(p) { mode = 'upsert'; payload = p; return resolve(); },
          then(res, rej) { resolve().then(res, rej); }
        };
        async function resolve() {
          if (table === 'sales' && mode === 'upsert') {
            const rec = Array.isArray(payload) ? payload[0] : payload;
            processedOrder.push(rec.id);
            // نُفشل تحديدًا ثاني دين يُحاول الرفع (محاكاة خطأ حقيقي: رقم هاتف غير صالح رفضه الخادم مثلًا)
            if (failOnSecondSale && processedOrder.length === 2) {
              return { error: { message: 'فشل مصطنع لاختبار الفشل الجزئي' } };
            }
            remoteSales.push(rec);
            return { error: null };
          }
          if (table === 'sales' && mode === 'select') return { data: [...remoteSales], error: null };
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

      const dbSupabase = await import('./js/db-supabase.js');
      await dbSupabase.initSupabaseClient({ url: 'https://fake.supabase.co', anonKey: 'fake' });
      const db = await import('./js/database.js');
      const sync = await import('./js/sync.js');

      await db.updateSettings({ backendMode: 'supabase', currentShopId: 'shop-1', currentUser: { id: 'u1', name: 'مالك', role: 'owner' } });
      const customer = await db.addCustomer({ name: 'زبون اختبار الفشل الجزئي' });

      // ننشئ الديون أثناء انقطاع مصطنع (navigator.onLine فحص فقط - لا تأثير فعلي بهذا الاختبار) حتى لا يُطلق
      // كل createSale محاولة مزامنة تلقائية خاصة به - نريد محاولة واحدة متحكّم بها فقط لعزل سلوك الفشل الجزئي
      const originalOnLine = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), 'onLine');
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });

      const ids = [];
      for (let i = 0; i < 3; i++) {
        const { sale } = await db.createSale({
          items: [{ product_id: null, product_name: `دين ${i}`, unit: 'خدمة', quantity: 1, selling_price: '20', cost_price: '0' }],
          paidDebt: 20, customerId: customer.id, customerName: customer.name, notes: ''
        });
        ids.push(sale.id);
      }

      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
      // محاولة مزامنة واحدة متحكّم بها: تتوقف عند أول فشل (ثاني عملية رفع لجدول sales تحديدًا بهذا الموك)
      await sync.flushQueue();

      const pending = await sync.getPendingItems();
      const status = await sync.getSyncStatus();
      return {
        totalCreated: ids.length,
        reachedRemote: remoteSales.length, // متوقع 1 فقط (الأول نجح، الثاني فشل، الثالث لم يُحاوَل بعد بسبب التوقف عند أول فشل)
        // نُحصي فقط عمليات مخزن sales (createSale يُدرج أيضًا عمليات لمخازن أخرى كالمعاملات النقدية/السجل
        // المحاسبي لكل دين - ليست موضوع هذا الاختبار، والتوقف عند أول فشل بـsales لا يمنع نجاحها أو فشلها)
        pendingRemaining: pending.filter((p) => p.storeName === 'sales').length, // متوقع 2 (الفاشل + غير المُحاوَل)
        processedOrderLength: processedOrder.length, // متوقع 2 فقط: لم يُحاوَل الثالث لأن التوقف عند أول فشل يحافظ على الترتيب
        syncStatus: status // يجب ألا تكون 'synced' طالما هناك عمليات معلّقة فعليًا
      };
    });

    assert('أُنشئت 3 ديون محليًا', result.totalCreated === 3);
    assert('دين واحد فقط وصل فعليًا لقاعدة البيانات (الثاني فشل، فتوقفت المحاولة)', result.reachedRemote === 1);
    assert('عمليتان ما زالتا معلّقتين بطابور الانتظار (لم تُعتبرا ناجحتين زورًا)', result.pendingRemaining === 2);
    assert('لم تتم محاولة الدين الثالث قبل حل فشل الثاني (الترتيب محفوظ، "لا تختل الحركات")', result.processedOrderLength === 2);
    assert('حالة المزامنة المُبلَّغة ليست "تمت المزامنة" طالما توجد عمليات معلّقة فعليًا', result.syncStatus !== 'synced');
  });
  summary();
})();

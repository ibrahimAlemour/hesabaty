// يثبّت إصلاحًا أمنيًا/ماليًا حرجًا: ديون (وأي سجل آخر) كانت تختفي محليًا بعد تحديث الصفحة رغم رفعها بنجاح
// فعليًا لسوبابيس. السبب: flushQueue() (sync.js) وpullFromRemote() (database.js) كانا يعملان أحيانًا
// بالتوازي دون أي تنسيق - لو رُفع سجل بنجاح وأُزيل من طابور الانتظار *بالضبط* بين لحظة قراءة pullFromRemote
// لجدول سوبابيس (لا يحتوي السجل بعد - لم يصل الرد من الشبكة بعد) ولحظة فحصه لطابور الانتظار (لم يعد يحتوي
// السجل، لأنه رُفع بنجاح للتو) يظهر "يتيمًا" زورًا فيُحذف محليًا. الإصلاح: withSyncLock مشترك (sync.js)
// يضمن تشغيل الدالتين بالتتابع لا بالتوازي أبدًا. هذا الاختبار يحاكي هذا التوقيت المعادي بدقة حتمية (بوابتان
// يتحكم بهما الاختبار نفسه، لا مهلات زمنية عشوائية) ويتحقق أن السجل يبقى ظاهرًا محليًا بعد pullFromRemote.
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    const result = await page.evaluate(async () => {
      let upsertGate = null, getAllGate = null;
      const remoteSales = [];

      function makeBuilder(table) {
        let mode = 'select', payload = null;
        const self = {
          select() { return self; },
          eq() { return self; },
          maybeSingle() { return resolve(); },
          delete() { mode = 'delete'; return self; },
          upsert(p) { mode = 'upsert'; payload = p; return resolve(); },
          then(res, rej) { resolve().then(res, rej); }
        };
        async function resolve() {
          if (table === 'sales' && mode === 'select') {
            const snapshot = [...remoteSales]; // لقطة فورية - "ما وصل فعليًا وقت تنفيذ الاستعلام"
            if (getAllGate) await getAllGate; // التأخير يحاكي زمن عودة رد الشبكة فقط، لا تغيّر اللقطة نفسها
            return { data: snapshot, error: null };
          }
          if (table === 'sales' && mode === 'upsert') {
            if (upsertGate) await upsertGate;
            const rec = Array.isArray(payload) ? payload[0] : payload;
            remoteSales.push(rec);
            return { error: null };
          }
          if (mode === 'delete') return { error: null };
          return { data: [], error: null }; // باقي الجداول: فارغة وفورية (خارج نطاق هذا الاختبار)
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

      await db.updateSettings({
        backendMode: 'supabase', currentShopId: 'shop-1',
        currentUser: { id: 'u1', name: 'صاحب المحل', role: 'owner' }
      });
      const customer = await db.addCustomer({ name: 'زبون اختبار التسابق' });

      let releaseUpsert, releaseGetAll;
      upsertGate = new Promise((r) => { releaseUpsert = r; });
      getAllGate = new Promise((r) => { releaseGetAll = r; });

      const { sale } = await db.createSale({
        items: [{ product_id: null, product_name: 'دين تجريبي', unit: 'خدمة', quantity: 1, selling_price: '100', cost_price: '0' }],
        paidDebt: 100, customerId: customer.id, customerName: customer.name, notes: ''
      });

      const pullPromise = db.pullFromRemote();
      await new Promise((r) => setTimeout(r, 40)); // مهلة لوصول pullFromRemote فعليًا لمخزن sales وأخذ لقطته
      releaseUpsert(); // الآن يكتمل رفع الدين وينجح، ويُزال من طابور الانتظار المحلي
      await new Promise((r) => setTimeout(r, 40)); // مهلة لإكمال flushQueue الإزالة من الطابور فعليًا
      releaseGetAll(); // "يصل" رد pullFromRemote المتأخر، حاملًا اللقطة القديمة رغم نجاح الرفع بالفعل
      await pullPromise;

      const localSales = await db.getSales();
      return {
        remoteHasSale: remoteSales.some((s) => s.id === sale.id),
        stillExistsLocally: localSales.some((s) => s.id === sale.id)
      };
    });

    assert('الدين وصل فعليًا لقاعدة البيانات (الرفع نجح)', result.remoteHasSale);
    assert('الدين بقي ظاهرًا محليًا بعد pullFromRemote رغم توقيت التسابق المعادي', result.stillExistsLocally);
  });
  summary();
})();

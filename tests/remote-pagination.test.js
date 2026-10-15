// يثبّت إصلاحًا جذريًا آخر لنفس بق "اختفاء الديون بعد تحديث الصفحة": remoteDb.getAll() (db-supabase.js) كان
// يستدعي select('*') وحده بدون ترقيم صفحات صريح، وهذا يخضع للحد الأقصى الافتراضي لصفوف الاستعلام الواحد
// بمشروع Supabase (1000 صفًا - Project Settings ⟵ API ⟵ Max Rows)، فتُعاد فقط أول 1000 صف. وبما أن
// pullFromRemote (database.js) يحذف محليًا أي سجل محلي "غير موجود بالصفوف المُستلَمة ولا بطابور الانتظار"،
// فإن أي جدول تجاوز 1000 صف (sales تحديدًا بعد تراكم فواتير كثيرة) كانت تُفقد سجلاته الزائدة محليًا عند كل
// سحب، رغم وجودها الفعلي بقاعدة البيانات - هذا يفسّر دقيقًا اختفاء ديون (جدول كبير) دون دفعات (جدول أصغر لم
// يصل بعد لنفس العدد). يحاكي هذا الاختبار جدول sales بـ1005 صفًا موجودًا مسبقًا على "الخادم" (محاكاة بيانات
// تراكمت قبل هذا الإصلاح، لا منشأة عبر التطبيق بهذا الاختبار) ويتحقق أن كل الصفوف الـ1005 تصل محليًا بعد
// pullFromRemote، وتبقى كاملة دون حذف أي منها بعد سحب ثانٍ متتالٍ.
const { withPage, assert, summary } = require('./_harness');

(async () => {
  await withPage(async (page) => {
    const result = await page.evaluate(async () => {
      const TOTAL_REMOTE_SALES = 1005;
      const remoteSales = [];
      for (let i = 0; i < TOTAL_REMOTE_SALES; i++) {
        remoteSales.push({
          id: `sale-${String(i).padStart(5, '0')}`,
          invoice_number: `INV-${i}`, invoice_seq: i + 1, customer_id: null,
          customer_name_snapshot: 'زبون', subtotal: 10, total_cost: 0, total_profit: 10, total_amount: 10,
          paid_cash: 0, paid_transfer: 0, paid_debt: 10, transfer_reference: '', transfer_bank: '',
          payment_status: 'debt', notes: '', is_deleted: false, created_by: 'مالك',
          created_at: new Date(2026, 0, 1, 0, 0, i).toISOString(), updated_at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
          edit_history: [], shop_id: 'shop-1'
        });
      }

      function makeBuilder(table) {
        let mode = 'select', payload = null, rangeFrom = null, rangeTo = null;
        const self = {
          select() { return self; },
          eq() { return self; },
          maybeSingle() { return resolve(); },
          // محاكاة سلوك Supabase الفعلي: يحترم range() فعليًا (يُرجع فقط الصفوف ضمن النطاق المطلوب) - بخلاف
          // بقية موكات الاختبارات الأخرى بهذا المستودع التي تتجاهله لأن بياناتها التجريبية صغيرة أصلًا
          range(from, to) { rangeFrom = from; rangeTo = to; return self; },
          delete() { mode = 'delete'; return self; },
          upsert(p) { mode = 'upsert'; payload = p; return resolve(); },
          then(res, rej) { resolve().then(res, rej); }
        };
        async function resolve() {
          if (table === 'sales' && mode === 'select') {
            // محاكاة سلوك Supabase الحقيقي: الحد الأقصى (1000 افتراضيًا) مفروض من الخادم نفسه دائمًا، حتى
            // لو لم يُستدعَ range() إطلاقًا (كما بالكود القديم قبل هذا الإصلاح) - وليس "يُرجع الكل افتراضيًا"
            const from = rangeFrom ?? 0, to = rangeTo ?? Math.min(999, remoteSales.length - 1);
            return { data: remoteSales.slice(from, to + 1), error: null };
          }
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

      const dbSupabase = await import('./js/db-supabase.js');
      await dbSupabase.initSupabaseClient({ url: 'https://fake.supabase.co', anonKey: 'fake' });
      const db = await import('./js/database.js');
      await db.updateSettings({
        backendMode: 'supabase', currentShopId: 'shop-1',
        currentUser: { id: 'u1', name: 'صاحب المحل', role: 'owner' }
      });

      await db.pullFromRemote();
      const afterFirstPull = (await db.getSales()).length;

      // سحب ثانٍ متتالٍ: يجب ألا يُحذف أي صف من الـ1005 (لا يُعتبر "يتيمًا" زورًا بسبب جلب غير مكتمل)
      await db.pullFromRemote();
      const afterSecondPull = (await db.getSales()).length;

      return { totalRemote: remoteSales.length, afterFirstPull, afterSecondPull };
    });

    assert('كل الـ1005 صفًا وصلت محليًا بعد السحب الأول (لا الـ1000 الأولى فقط)', result.afterFirstPull === 1005);
    assert('لم يُحذف أي صف بعد سحب ثانٍ متتالٍ (لا فقدان زائف للصفوف فوق حد الـ1000)', result.afterSecondPull === 1005);
  });
  summary();
})();

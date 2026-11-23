// يثبّت منطق بوت تيليجرام (المرحلة 1) بـworker.js: الربط عبر /start، عزل shop_id، حساب الرصيد (شامل الخصم)،
// مطابقة الأسماء البسيطة (تطابق/غموض/لا يوجد)، والنيات الأربع (رصيد/فواتير/مبيعات اليوم/أكثر المدينين).
// لا شبكة حقيقية هنا إطلاقًا: نموذج fetch مزيَّف يحاكي جداول سوبابيس (REST)، ونموذج env.AI مزيَّف يحاكي
// Workers AI (استبدلنا Gemini الخارجي به بعد نفاد حصته المجانية فعليًا - راجع classifyIntent بـworker.js)
const { assert, summary } = require('./_harness');

const NOW = new Date();
const FUTURE = new Date(NOW.getTime() + 5 * 60 * 1000).toISOString();
const PAST = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();

function freshDb() {
  return {
    shops: [{ id: 'shop1', name: 'محل الاختبار' }],
    bot_link_codes: [
      { code: 'validcode', shop_id: 'shop1', role: 'owner', expires_at: FUTURE },
      { code: 'expiredcode', shop_id: 'shop1', role: 'employee', expires_at: PAST }
    ],
    bot_users: [],
    customers: [
      { id: 'c1', name: 'أحمد خالد', phone: '0599111111', shop_id: 'shop1', is_deleted: false },
      { id: 'c2', name: 'خالد محمود', phone: '0599222222', shop_id: 'shop1', is_deleted: false },
      { id: 'c3', name: 'نور بلا دين', phone: '', shop_id: 'shop1', is_deleted: false }
    ],
    sales: [
      { id: 's1', shop_id: 'shop1', customer_id: 'c1', paid_debt: 10000, total_amount: 10000, paid_cash: 0, paid_transfer: 0, is_deleted: false, created_at: new Date().toISOString(), invoice_number: 'INV-000001', payment_status: 'debt', notes: 'طلبية للدار' },
      { id: 's2', shop_id: 'shop1', customer_id: 'c1', paid_debt: 5000, total_amount: 5000, paid_cash: 0, paid_transfer: 0, is_deleted: false, created_at: new Date().toISOString(), invoice_number: 'INV-000002', payment_status: 'debt', notes: '' },
      { id: 's3', shop_id: 'shop1', customer_id: 'c2', paid_debt: 20000, total_amount: 20000, paid_cash: 0, paid_transfer: 0, is_deleted: false, created_at: new Date().toISOString(), invoice_number: 'INV-000003', payment_status: 'debt', notes: '' }
    ],
    payments: [
      { id: 'p1', shop_id: 'shop1', customer_id: 'c1', amount: 5000, discount: 2000, is_deleted: false }
    ]
  };
}

let DB;
let telegramSent = [];

// نموذج Workers AI مزيَّف (env.AI.run) - لا يمرّ عبر fetch إطلاقًا، استدعاء مباشر مثل الـbinding الحقيقي
const mockAI = {
  async run(model, { messages }) {
    global.__AI_CALL_COUNT__ = (global.__AI_CALL_COUNT__ || 0) + 1;
    global.__LAST_SYSTEM_PROMPT__ = messages.find(m => m.role === 'system')?.content || '';
    if (global.__AI_FAIL_ALWAYS__) throw new Error('Workers AI غير متاح (محاكاة فشل دائم)');
    if (global.__AI_FAIL_ONCE__) { global.__AI_FAIL_ONCE__ = false; throw new Error('خطأ عابر (محاكاة)'); }
    const userText = messages.find(m => m.role === 'user').content;
    const intentJson = global.__AI_INTENT_MOCK__ ? global.__AI_INTENT_MOCK__(userText) : { intent: 'unknown' };
    // بعض موديلات Workers AI قد تُرجع response ككائن منظَّم جاهز بدل نص خام (هذا بالضبط ما حصل فعليًا أول
    // استخدام حي لـllama-3.2-3b-instruct وسبّب "raw.match is not a function") - نحاكي هذا الاحتمال هنا أيضًا
    return { response: global.__AI_RETURN_OBJECT__ ? intentJson : JSON.stringify(intentJson) };
  }
};

function mockFetch(url, opts = {}) {
  url = String(url);
  const method = opts.method || 'GET';

  if (url.includes('api.telegram.org')) {
    // نتجاهل sendChatAction (مؤشر "يكتب...") عمدًا هنا - لا يحمل .text ولا يهمّنا بهذه الاختبارات، فقط
    // رسائل sendMessage الفعلية المرسَلة فعليًا للمستخدم هي ما تُثبَّت صحتها بهذا الملف
    if (url.includes('/sendMessage')) telegramSent.push(JSON.parse(opts.body));
    if (url.includes('/sendChatAction')) global.__TYPING_ACTIONS_SENT__ = (global.__TYPING_ACTIONS_SENT__ || 0) + 1;
    return Promise.resolve({ ok: true, text: async () => '{}' });
  }

  const m = url.match(/\/rest\/v1\/([a-z_]+)\??(.*)$/);
  if (!m) return Promise.resolve({ ok: true, json: async () => ([]) });
  const table = m[1];
  const qs = new URLSearchParams(m[2]);

  const applyFilters = (rows) => rows.filter(row => {
    for (const [key, value] of qs.entries()) {
      if (key === 'select' || key === 'order' || key === 'limit' || key === 'on_conflict') continue;
      // URLSearchParams يفكّ ترميز percent-encoding تلقائيًا عند القراءة - لا حاجة لفكّه مرة ثانية هنا
      const [op, ...rest] = value.split('.');
      const val = rest.join('.');
      if (op === 'eq' && String(row[key]) !== val) return false;
      if (op === 'gte' && !(row[key] >= val)) return false;
      if (op === 'lte' && !(row[key] <= val)) return false;
      if (op === 'ilike') {
        const pattern = val.replace(/^%|%$/g, '');
        if (!String(row[key] || '').includes(pattern)) return false;
      }
      if (op === 'in') {
        const ids = val.replace(/^\(|\)$/g, '').split(',');
        if (!ids.includes(String(row[key]))) return false;
      }
    }
    return true;
  });

  if (method === 'GET') {
    const rows = applyFilters(DB[table] || []);
    return Promise.resolve({ ok: true, json: async () => rows });
  }
  if (method === 'POST') {
    const body = JSON.parse(opts.body);
    const rows = Array.isArray(body) ? body : [body];
    if (table === 'bot_users') {
      for (const r of rows) {
        const idx = DB.bot_users.findIndex(b => b.chat_id === r.chat_id);
        if (idx >= 0) DB.bot_users[idx] = { ...DB.bot_users[idx], ...r };
        else DB.bot_users.push({ id: 'bu' + DB.bot_users.length, ...r });
      }
    } else {
      DB[table] = (DB[table] || []).concat(rows);
    }
    return Promise.resolve({ ok: true, json: async () => rows });
  }
  if (method === 'PATCH') {
    const patch = JSON.parse(opts.body);
    const rows = applyFilters(DB[table] || []);
    for (const row of rows) Object.assign(row, patch);
    return Promise.resolve({ ok: true, json: async () => rows });
  }
  if (method === 'DELETE') {
    const before = (DB[table] || []).length;
    DB[table] = applyFilters(DB[table] || []).length
      ? (DB[table] || []).filter(row => !applyFilters([row]).length)
      : DB[table];
    return Promise.resolve({ ok: true, json: async () => ([]) });
  }
  return Promise.resolve({ ok: true, json: async () => ([]) });
}

const ENV = { TELEGRAM_BOT_TOKEN: 'test-token', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key', AI: mockAI };

function fakeRequest(bodyObj, headers = {}) {
  return { method: 'POST', headers: { get: (k) => headers[k] || null }, json: async () => bodyObj };
}

(async () => {
  global.fetch = mockFetch;
  const worker = await import('../worker.js');

  // ========== 1) /start بكود صالح: يربط chat_id بالمحل ويرسل رسالة نجاح ==========
  DB = freshDb(); telegramSent = [];
  await worker.handleTelegramWebhook(fakeRequest({
    message: { chat: { id: 111 }, text: '/start validcode', from: { first_name: 'محمد', username: 'mohammad' } }
  }), ENV);
  assert('ربط /start بكود صالح: أُنشئ صف ببوت bot_users', DB.bot_users.length === 1);
  assert('ربط /start: shop_id الصحيح من الكود (shop1)', DB.bot_users[0]?.shop_id === 'shop1');
  assert('ربط /start: الدور owner كما بالكود', DB.bot_users[0]?.role === 'owner');
  assert('ربط /start: الكود يُحذف فورًا بعد الاستخدام', !DB.bot_link_codes.some(c => c.code === 'validcode'));
  assert('ربط /start: رسالة نجاح أُرسلت وتحتوي اسم المحل', telegramSent.some(m => m.text.includes('تم الربط') && m.text.includes('محل الاختبار')));

  // ========== 2) /start بكود منتهي الصلاحية: لا يربط، يرسل رسالة رفض ==========
  DB = freshDb(); telegramSent = [];
  await worker.handleTelegramWebhook(fakeRequest({
    message: { chat: { id: 222 }, text: '/start expiredcode', from: { first_name: 'أ' } }
  }), ENV);
  assert('كود منتهي: لا يُنشأ أي ربط', DB.bot_users.length === 0);
  assert('كود منتهي: رسالة رفض واضحة', telegramSent.some(m => m.text.includes('غير صالح') || m.text.includes('منتهي')));

  // ========== 3) رسالة من chat_id غير مربوط: رفض واضح ==========
  DB = freshDb(); telegramSent = [];
  await worker.handleTelegramWebhook(fakeRequest({
    message: { chat: { id: 999 }, text: 'رصيد أحمد', from: {} }
  }), ENV);
  assert('chat_id غير مربوط: رسالة رفض بدل تنفيذ أي استعلام', telegramSent.some(m => m.text.includes('غير مرتبط')));

  // ========== 4) رصيد زبون: تطابق فريد، يشمل الخصم بحساب الرصيد ==========
  DB = freshDb(); telegramSent = [];
  DB.bot_users.push({ chat_id: 333, shop_id: 'shop1', role: 'owner', name: 'صاحب المحل' });
  global.__AI_INTENT_MOCK__ = (text) => ({ intent: 'customer_balance', customer: 'أحمد خالد', note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد أحمد خالد', from: {} } }), ENV);
  // الدين: 10000+5000=15000 - المدفوع: 5000+2000(خصم)=7000 => الرصيد = 8000 فلس = 80 ₪
  assert('رصيد زبون: المبلغ الصحيح شاملًا الخصم (80.00 ₪)', telegramSent.some(m => m.text.includes('80.00')));
  assert('مؤشر "يكتب..." يُرسَل أثناء المعالجة (تحسين تجربة البطء)', (global.__TYPING_ACTIONS_SENT__ || 0) >= 1);
  assert('رصيد زبون: اسم الزبون الصحيح بالرد', telegramSent.some(m => m.text.includes('أحمد خالد')));

  // ========== 4.5) الموديل يُرجع response ككائن منظَّم بدل نص خام - يجب ألا ينهار الكود (راجع تعليق المحاكاة) ==========
  telegramSent = [];
  global.__AI_RETURN_OBJECT__ = true;
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'customer_balance', customer: 'أحمد خالد العمور', note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد أحمد خالد العمور', from: {} } }), ENV);
  assert('response ككائن بدل نص: لا ينهار الكود، والرد يصل صحيحًا', telegramSent.some(m => m.text.includes('80.00')));
  global.__AI_RETURN_OBJECT__ = false;

  // ========== 5) رصيد زبون بلا أي دين: رسالة "لا يوجد مستحق" ==========
  telegramSent = [];
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'customer_balance', customer: 'نور بلا دين', note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد نور', from: {} } }), ENV);
  assert('زبون بلا دين: رسالة واضحة بعدم وجود مستحق', telegramSent.some(m => m.text.includes('لا يوجد عليه أي مبلغ')));

  // ========== 6) اسم غامض (يطابق أكثر من زبون): لا يُخمَّن، يُسرَد الاحتمالان ==========
  telegramSent = [];
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'customer_balance', customer: 'خالد', note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد خالد', from: {} } }), ENV);
  const ambiguousMsg = telegramSent.find(m => m.text.includes('أكثر من زبون'));
  assert('اسم غامض: يعرض رسالة توضيح بدل تخمين زبون واحد', !!ambiguousMsg);
  assert('اسم غامض: يسرد الزبونين المتطابقين كليهما', ambiguousMsg && ambiguousMsg.text.includes('أحمد خالد') && ambiguousMsg.text.includes('خالد محمود'));

  // ========== 7) اسم غير موجود إطلاقًا ==========
  telegramSent = [];
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'customer_balance', customer: 'زبون لا وجود له', note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد xxx', from: {} } }), ENV);
  assert('اسم غير موجود: رسالة "ما لقيت" واضحة', telegramSent.some(m => m.text.includes('ما لقيت')));

  // ========== 8) فواتير زبون مع فلترة بالملاحظات ==========
  telegramSent = [];
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'customer_invoices', customer: 'أحمد خالد', note_contains: 'للدار', from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'فواتير أحمد خالد اللي فيها للدار', from: {} } }), ENV);
  const invoicesMsg = telegramSent[0];
  assert('فواتير بفلتر ملاحظات: فاتورة واحدة فقط (الوحيدة التي ملاحظتها تحتوي "للدار")', invoicesMsg && invoicesMsg.text.includes('INV-000001') && !invoicesMsg.text.includes('INV-000002'));

  // ========== 9) مبيعات اليوم ==========
  telegramSent = [];
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'today_sales', customer: null, note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'مبيعات اليوم', from: {} } }), ENV);
  // كل المبيعات الثلاث بـfreshDb() تاريخها "اليوم" (new Date().toISOString() وقت بناء DB) => الإجمالي 10000+5000+20000=35000=350.00
  assert('مبيعات اليوم: الإجمالي الصحيح وعدد الفواتير', telegramSent.some(m => m.text.includes('3 فاتورة') && m.text.includes('350.00')));

  // ========== 10) أكثر الزبائن ديونًا: ترتيب تنازلي صحيح، استبعاد من لا دين عليه ==========
  telegramSent = [];
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'top_debtors', customer: null, note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'أكثر الزبائن ديون', from: {} } }), ENV);
  const topMsg = telegramSent[0].text;
  const idxC2 = topMsg.indexOf('خالد محمود'); // رصيده 200 (الأعلى)
  const idxC1 = topMsg.indexOf('أحمد خالد'); // رصيده 80
  assert('أكثر المدينين: الترتيب تنازلي (خالد محمود 200 قبل أحمد خالد 80)', idxC2 >= 0 && idxC1 >= 0 && idxC2 < idxC1);
  assert('أكثر المدينين: لا يظهر زبون بلا دين (نور)', !topMsg.includes('نور بلا دين'));

  // ========== 10.5) حدود "اليوم المحلي" بتوقيت غزة (gazaDayBoundsUtc) - فحص مباشر بتاريخ ثابت ==========
  // غزة شتاءً = UTC+2 بلا توقيت صيفي - منتصف الليل المحلي (00:00) = الساعة 22:00 UTC باليوم السابق
  const gazaBounds = worker.gazaDayBoundsUtc('2026-11-23');
  assert('حدود يوم غزة: بداية اليوم محوَّلة لـUTC بشكل صحيح (لا منتصف ليل UTC)', gazaBounds.start === '2026-11-22T22:00:00.000Z');
  assert('حدود يوم غزة: نهاية اليوم محوَّلة لـUTC بشكل صحيح', gazaBounds.end === '2026-11-23T21:59:59.999Z');

  // ========== 10.6) الـprompt يحتوي تاريخ اليوم/أمس الفعليَّين بتوقيت غزة (لا يُترَك للذكاء الاصطناعي يحسبهما) ==========
  telegramSent = [];
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'today_sales', customer: null, note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'مبيعات اليوم', from: {} } }), ENV);
  const expectedTodayGaza = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Gaza' }).format(new Date());
  const expectedYesterdayGaza = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Gaza' }).format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  assert('الـprompt يحتوي تاريخ اليوم الصحيح بتوقيت غزة', global.__LAST_SYSTEM_PROMPT__.includes(expectedTodayGaza));
  assert('الـprompt يحتوي تاريخ أمس الصحيح بتوقيت غزة', global.__LAST_SYSTEM_PROMPT__.includes(expectedYesterdayGaza));

  // ========== 10.7) "إيش أخذ فلان مبارح؟": فاتورة الساعة 00:30 بتوقيت غزة أمس يجب أن تُحتسَب ضمن أمس بالضبط
  // (هذا بالضبط ما كان يفشل بالمنطق القديم المعتمد على حدود UTC بدل غزة - كانت لتُحتسَب ضمن يوم خطأ) ==========
  const yesterdayGazaBounds = worker.gazaDayBoundsUtc(expectedYesterdayGaza);
  const nearMidnightYesterdayGaza = new Date(new Date(yesterdayGazaBounds.start).getTime() + 30 * 60 * 1000).toISOString();
  DB.sales.push({
    id: 's9', shop_id: 'shop1', customer_id: 'c1', paid_debt: 0, total_amount: 7777, paid_cash: 7777, paid_transfer: 0,
    is_deleted: false, created_at: nearMidnightYesterdayGaza, invoice_number: 'INV-YEST', payment_status: 'paid', notes: 'طلبية مبارح'
  });
  telegramSent = [];
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'customer_invoices', customer: 'أحمد خالد', note_contains: null, from: expectedYesterdayGaza, to: expectedYesterdayGaza });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'إيش أخذ أحمد خالد مبارح؟', from: {} } }), ENV);
  assert('"مبارح": فاتورة 00:30 بتوقيت غزة أمس تظهر ضمن نتائج أمس بالضبط', telegramSent.some(m => m.text.includes('INV-YEST') && m.text.includes('77.77')));

  // ========== 11) عزل المحلات: كل استعلامات REST المُرسَلة لمحل shop1 تحتوي shop_id=eq.shop1 فعليًا ==========
  const capturedUrls = [];
  const originalMock = global.fetch;
  global.fetch = (url, opts) => { capturedUrls.push(String(url)); return originalMock(url, opts); };
  telegramSent = [];
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'top_debtors', customer: null, note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'أكثر المدينين', from: {} } }), ENV);
  // استثناء وحيد متوقَّع: جلب bot_users نفسه (بـchat_id) - هذا بالضبط ما يُحدِّد shop_id أصلًا، فمن المستحيل
  // منطقيًا فلترته هو بـshop_id قبل أن نعرفه. كل استعلام بعده (بمجرد معرفة shop_id) يجب أن يُفلتَر به فعليًا
  const supabaseUrls = capturedUrls.filter(u => u.includes('/rest/v1/') && !u.includes('/rest/v1/bot_users?chat_id='));
  assert('عزل المحلات: كل استعلامات سوبابيس (بعد تحديد shop_id من bot_users) مفلترة بـshop_id=eq.shop1', supabaseUrls.length > 0 && supabaseUrls.every(u => u.includes('shop_id=eq.shop1')));
  global.fetch = originalMock;

  // ========== 12) ناتج الذكاء الاصطناعي غير متوقَّع (نية خارج القائمة البيضاء): يُرفَض ويُعامَل كـunknown بأمان ==========
  telegramSent = [];
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'DROP TABLE customers;--', customer: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'أي شيء', from: {} } }), ENV);
  assert('نية غير متوقَّعة من الذكاء الاصطناعي تُعامَل كـunknown بأمان (رد توضيحي، لا تنفيذ)', telegramSent.some(m => m.text.includes('ما قدرت أفهم')));

  // ========== 13) فشل عابر واحد من Workers AI: محاولة ثانية تلقائية تنجح ==========
  telegramSent = [];
  global.__AI_CALL_COUNT__ = 0;
  global.__AI_FAIL_ONCE__ = true;
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'today_sales', customer: null, note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'مبيعات اليوم', from: {} } }), ENV);
  assert('فشل عابر من Workers AI: محاولة ثانية تلقائية (استدعاءان لا واحد)', global.__AI_CALL_COUNT__ === 2);
  assert('فشل عابر من Workers AI: المحاولة الثانية تنجح ويصل الرد الصحيح للمستخدم', telegramSent.some(m => m.text.includes('مبيعات اليوم')));

  // ========== 14) فشل مستمر من Workers AI (محاولتان كلتاهما تفشلان): رسالة رفض واضحة بدل انتظار بلا نهاية ==========
  telegramSent = [];
  global.__AI_CALL_COUNT__ = 0;
  global.__AI_FAIL_ALWAYS__ = true;
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'مبيعات اليوم', from: {} } }), ENV);
  assert('فشل مستمر: محاولتان بالضبط (أصلية + إعادة واحدة) قبل الاستسلام', global.__AI_CALL_COUNT__ === 2);
  assert('فشل مستمر: رسالة رفض واضحة للمستخدم بعد استنفاد المحاولات', telegramSent.some(m => m.text.includes('تعذّر فهم طلبك')));
  global.__AI_FAIL_ALWAYS__ = false;

  // ========== 15) التحقق الأمني من secret_token بالـwebhook ==========
  telegramSent = [];
  const envWithSecret = { ...ENV, TELEGRAM_WEBHOOK_SECRET: 'real-secret' };
  const res1 = await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد أحمد خالد', from: {} } }, {}), envWithSecret);
  assert('بدون secret_token الصحيح بالترويسة: الطلب يُرفض (401) ولا يُنفَّذ شيء', res1.status === 401 && telegramSent.length === 0);
  const res2 = await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد أحمد خالد', from: {} } }, { 'X-Telegram-Bot-Api-Secret-Token': 'real-secret' }), envWithSecret);
  assert('بـsecret_token الصحيح: الطلب يُعالَج بشكل طبيعي', res2.status === 200);

  // ========== 16) اختيار زبون غامض برقم بسيط ("1") بدل إعادة كتابة الاسم - يتجاوز الذكاء الاصطناعي كليًا ==========
  // (هذا تحديدًا ما كان يُفشِل فعليًا بالإنتاج: رد "1" بلا سياق كان يُرسَل للذكاء الاصطناعي فيُهلوِس)
  telegramSent = [];
  global.__AI_CALL_COUNT__ = 0;
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'customer_balance', customer: 'خالد', note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد خالد', from: {} } }), ENV);
  const ambiguousMsg2 = telegramSent[telegramSent.length - 1];
  assert('غموض الاسم: الرسالة تدعو لاختيار برقم', !!ambiguousMsg2 && ambiguousMsg2.text.includes('ابعت رقم الزبون'));
  const aiCallsBeforeNumericPick = global.__AI_CALL_COUNT__;
  telegramSent = [];
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: '1', from: {} } }), ENV);
  assert('اختيار رقمي: لا يستدعي الذكاء الاصطناعي إطلاقًا', global.__AI_CALL_COUNT__ === aiCallsBeforeNumericPick);
  assert('اختيار رقمي: يحل للزبون الأول بالقائمة المعروضة (أحمد خالد، 80.00)', telegramSent.some(m => m.text.includes('أحمد خالد') && m.text.includes('80.00')));

  // ========== 17) اختيار رقمي بعد انتهاء صلاحية حالة الانتظار (دقيقتين): يُعامَل كرسالة عادية بالذكاء الاصطناعي ==========
  telegramSent = [];
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'customer_balance', customer: 'خالد', note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد خالد', from: {} } }), ENV);
  const botUserRow333 = DB.bot_users.find(b => b.chat_id === 333);
  botUserRow333.pending_expires_at = PAST; // محاكاة انتهاء الصلاحية (دقيقتان انقضتا فعليًا)
  telegramSent = [];
  global.__AI_CALL_COUNT__ = 0;
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'unknown' });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: '1', from: {} } }), ENV);
  assert('اختيار رقمي بعد انتهاء الصلاحية: يُستدعى الذكاء الاصطناعي (لا يُعامَل كاختيار صالح)', global.__AI_CALL_COUNT__ === 1);

  // ========== 18) تنظيف اسم الزبون المستخرَج من كلمة تاريخ نسبي علقت به ("سامر مبارح" -> "سامر") ==========
  // يحاكي بالضبط الخلل المُبلَّغ: الذكاء الاصطناعي يلصق كلمة التاريخ النسبي بآخر اسم الزبون المستخرَج، فلا يطابق
  // أي زبون فعلي بلا هذا التنظيف (اسم فريد هنا تحديدًا حتى لا يتشابك مع "خالد"/"أحمد خالد" الموجودين بالاختبارات)
  DB.customers.push({ id: 'c4', name: 'سامر', phone: '', shop_id: 'shop1', is_deleted: false });
  telegramSent = [];
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'customer_balance', customer: 'سامر مبارح', note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'ايش اخذ سامر مبارح', from: {} } }), ENV);
  assert('تنظيف الاسم: تجاهل كلمة التاريخ النسبي الملتصقة يسمح بإيجاد الزبون الحقيقي', telegramSent.some(m => m.text.includes('سامر') && m.text.includes('لا يوجد عليه أي مبلغ')));

  // ========== 19) حاجز أمان: رفض اسم زبون "مستخرَج" فعليًا نص تعليمات البرومبت نفسه (هلوسة نادرة لوحظت فعليًا) ==========
  telegramSent = [];
  global.__AI_INTENT_MOCK__ = () => ({ intent: 'customer_balance', customer: 'اسم الزبون المذكور أو null', note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد فلان', from: {} } }), ENV);
  assert('حاجز الهلوسة: نص تعليمات البرومبت المسرَّب بحقل customer يُرفَض ولا يُستخدَم كاسم حقيقي', telegramSent.some(m => m.text.includes('بدي اسم الزبون')));
})().then(() => summary()).catch(e => { console.error(e); process.exitCode = 1; });

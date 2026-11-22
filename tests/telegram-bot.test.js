// يثبّت منطق بوت تيليجرام (المرحلة 1) بـworker.js: الربط عبر /start، عزل shop_id، حساب الرصيد (شامل الخصم)،
// مطابقة الأسماء البسيطة (تطابق/غموض/لا يوجد)، والنيات الأربع (رصيد/فواتير/مبيعات اليوم/أكثر المدينين).
// لا شبكة حقيقية هنا إطلاقًا: نموذج fetch مزيَّف يحاكي جداول سوبابيس (REST) واستجابة Gemini داخل الذاكرة.
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

function mockFetch(url, opts = {}) {
  url = String(url);
  const method = opts.method || 'GET';

  if (url.includes('generativelanguage.googleapis.com')) {
    global.__GEMINI_CALL_COUNT__ = (global.__GEMINI_CALL_COUNT__ || 0) + 1;
    if (global.__GEMINI_FAIL_ALWAYS_503__) {
      return Promise.resolve({ ok: false, status: 503, text: async () => 'high demand' });
    }
    if (global.__GEMINI_FAIL_ONCE_503__) {
      global.__GEMINI_FAIL_ONCE_503__ = false;
      return Promise.resolve({ ok: false, status: 503, text: async () => 'high demand' });
    }
    const body = JSON.parse(opts.body);
    const userText = body.contents[0].parts[0].text;
    const intentJson = global.__GEMINI_MOCK__ ? global.__GEMINI_MOCK__(userText) : { intent: 'unknown' };
    return Promise.resolve({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(intentJson) }] } }] }) });
  }

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
  if (method === 'DELETE') {
    const before = (DB[table] || []).length;
    DB[table] = applyFilters(DB[table] || []).length
      ? (DB[table] || []).filter(row => !applyFilters([row]).length)
      : DB[table];
    return Promise.resolve({ ok: true, json: async () => ([]) });
  }
  return Promise.resolve({ ok: true, json: async () => ([]) });
}

const ENV = { TELEGRAM_BOT_TOKEN: 'test-token', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key', GEMINI_API_KEY: 'test-gemini-key' };

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
  global.__GEMINI_MOCK__ = (text) => ({ intent: 'customer_balance', customer: 'أحمد خالد', note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد أحمد خالد', from: {} } }), ENV);
  // الدين: 10000+5000=15000 - المدفوع: 5000+2000(خصم)=7000 => الرصيد = 8000 فلس = 80 ₪
  assert('رصيد زبون: المبلغ الصحيح شاملًا الخصم (80.00 ₪)', telegramSent.some(m => m.text.includes('80.00')));
  assert('مؤشر "يكتب..." يُرسَل أثناء المعالجة (تحسين تجربة البطء)', (global.__TYPING_ACTIONS_SENT__ || 0) >= 1);
  assert('رصيد زبون: اسم الزبون الصحيح بالرد', telegramSent.some(m => m.text.includes('أحمد خالد')));

  // ========== 5) رصيد زبون بلا أي دين: رسالة "لا يوجد مستحق" ==========
  telegramSent = [];
  global.__GEMINI_MOCK__ = () => ({ intent: 'customer_balance', customer: 'نور بلا دين', note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد نور', from: {} } }), ENV);
  assert('زبون بلا دين: رسالة واضحة بعدم وجود مستحق', telegramSent.some(m => m.text.includes('لا يوجد عليه أي مبلغ')));

  // ========== 6) اسم غامض (يطابق أكثر من زبون): لا يُخمَّن، يُسرَد الاحتمالان ==========
  telegramSent = [];
  global.__GEMINI_MOCK__ = () => ({ intent: 'customer_balance', customer: 'خالد', note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد خالد', from: {} } }), ENV);
  const ambiguousMsg = telegramSent.find(m => m.text.includes('أكثر من زبون'));
  assert('اسم غامض: يعرض رسالة توضيح بدل تخمين زبون واحد', !!ambiguousMsg);
  assert('اسم غامض: يسرد الزبونين المتطابقين كليهما', ambiguousMsg && ambiguousMsg.text.includes('أحمد خالد') && ambiguousMsg.text.includes('خالد محمود'));

  // ========== 7) اسم غير موجود إطلاقًا ==========
  telegramSent = [];
  global.__GEMINI_MOCK__ = () => ({ intent: 'customer_balance', customer: 'زبون لا وجود له', note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد xxx', from: {} } }), ENV);
  assert('اسم غير موجود: رسالة "ما لقيت" واضحة', telegramSent.some(m => m.text.includes('ما لقيت')));

  // ========== 8) فواتير زبون مع فلترة بالملاحظات ==========
  telegramSent = [];
  global.__GEMINI_MOCK__ = () => ({ intent: 'customer_invoices', customer: 'أحمد خالد', note_contains: 'للدار', from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'فواتير أحمد خالد اللي فيها للدار', from: {} } }), ENV);
  const invoicesMsg = telegramSent[0];
  assert('فواتير بفلتر ملاحظات: فاتورة واحدة فقط (الوحيدة التي ملاحظتها تحتوي "للدار")', invoicesMsg && invoicesMsg.text.includes('INV-000001') && !invoicesMsg.text.includes('INV-000002'));

  // ========== 9) مبيعات اليوم ==========
  telegramSent = [];
  global.__GEMINI_MOCK__ = () => ({ intent: 'today_sales', customer: null, note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'مبيعات اليوم', from: {} } }), ENV);
  // كل المبيعات الثلاث بـfreshDb() تاريخها "اليوم" (new Date().toISOString() وقت بناء DB) => الإجمالي 10000+5000+20000=35000=350.00
  assert('مبيعات اليوم: الإجمالي الصحيح وعدد الفواتير', telegramSent.some(m => m.text.includes('3 فاتورة') && m.text.includes('350.00')));

  // ========== 10) أكثر الزبائن ديونًا: ترتيب تنازلي صحيح، استبعاد من لا دين عليه ==========
  telegramSent = [];
  global.__GEMINI_MOCK__ = () => ({ intent: 'top_debtors', customer: null, note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'أكثر الزبائن ديون', from: {} } }), ENV);
  const topMsg = telegramSent[0].text;
  const idxC2 = topMsg.indexOf('خالد محمود'); // رصيده 200 (الأعلى)
  const idxC1 = topMsg.indexOf('أحمد خالد'); // رصيده 80
  assert('أكثر المدينين: الترتيب تنازلي (خالد محمود 200 قبل أحمد خالد 80)', idxC2 >= 0 && idxC1 >= 0 && idxC2 < idxC1);
  assert('أكثر المدينين: لا يظهر زبون بلا دين (نور)', !topMsg.includes('نور بلا دين'));

  // ========== 11) عزل المحلات: كل استعلامات REST المُرسَلة لمحل shop1 تحتوي shop_id=eq.shop1 فعليًا ==========
  const capturedUrls = [];
  const originalMock = global.fetch;
  global.fetch = (url, opts) => { capturedUrls.push(String(url)); return originalMock(url, opts); };
  telegramSent = [];
  global.__GEMINI_MOCK__ = () => ({ intent: 'top_debtors', customer: null, note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'أكثر المدينين', from: {} } }), ENV);
  // استثناء وحيد متوقَّع: جلب bot_users نفسه (بـchat_id) - هذا بالضبط ما يُحدِّد shop_id أصلًا، فمن المستحيل
  // منطقيًا فلترته هو بـshop_id قبل أن نعرفه. كل استعلام بعده (بمجرد معرفة shop_id) يجب أن يُفلتَر به فعليًا
  const supabaseUrls = capturedUrls.filter(u => u.includes('/rest/v1/') && !u.includes('/rest/v1/bot_users?chat_id='));
  assert('عزل المحلات: كل استعلامات سوبابيس (بعد تحديد shop_id من bot_users) مفلترة بـshop_id=eq.shop1', supabaseUrls.length > 0 && supabaseUrls.every(u => u.includes('shop_id=eq.shop1')));
  global.fetch = originalMock;

  // ========== 12) ناتج Gemini غير متوقَّع (نية خارج القائمة البيضاء): يُرفَض ويُعامَل كـunknown بأمان ==========
  telegramSent = [];
  global.__GEMINI_MOCK__ = () => ({ intent: 'DROP TABLE customers;--', customer: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'أي شيء', from: {} } }), ENV);
  assert('نية غير متوقَّعة من Gemini تُعامَل كـunknown بأمان (رد توضيحي، لا تنفيذ)', telegramSent.some(m => m.text.includes('ما قدرت أفهم')));

  // ========== 13) فشل مؤقت (503 "ازدحام") من Gemini: محاولة واحدة إضافية تلقائية قبل الاستسلام ==========
  telegramSent = [];
  global.__GEMINI_CALL_COUNT__ = 0;
  global.__GEMINI_FAIL_ONCE_503__ = true;
  global.__GEMINI_MOCK__ = () => ({ intent: 'today_sales', customer: null, note_contains: null, from: null, to: null });
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'مبيعات اليوم', from: {} } }), ENV);
  assert('503 عابر من Gemini: محاولة ثانية تلقائية (استدعاءان لا واحد)', global.__GEMINI_CALL_COUNT__ === 2);
  assert('503 عابر من Gemini: المحاولة الثانية تنجح ويصل الرد الصحيح للمستخدم', telegramSent.some(m => m.text.includes('مبيعات اليوم')));

  // ========== 14) ازدحام 503 مستمر (3 محاولات كلها تفشل): رسالة رفض واضحة بدل انتظار بلا نهاية ==========
  telegramSent = [];
  global.__GEMINI_CALL_COUNT__ = 0;
  global.__GEMINI_FAIL_ALWAYS_503__ = true;
  await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'مبيعات اليوم', from: {} } }), ENV);
  assert('503 مستمر: 3 محاولات بالضبط (محاولة أصلية + محاولتان إضافيتان) قبل الاستسلام', global.__GEMINI_CALL_COUNT__ === 3);
  assert('503 مستمر: رسالة رفض واضحة للمستخدم بعد استنفاد كل المحاولات', telegramSent.some(m => m.text.includes('تعذّر فهم طلبك')));
  global.__GEMINI_FAIL_ALWAYS_503__ = false;

  // ========== 15) التحقق الأمني من secret_token بالـwebhook ==========
  telegramSent = [];
  const envWithSecret = { ...ENV, TELEGRAM_WEBHOOK_SECRET: 'real-secret' };
  const res1 = await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد أحمد خالد', from: {} } }, {}), envWithSecret);
  assert('بدون secret_token الصحيح بالترويسة: الطلب يُرفض (401) ولا يُنفَّذ شيء', res1.status === 401 && telegramSent.length === 0);
  const res2 = await worker.handleTelegramWebhook(fakeRequest({ message: { chat: { id: 333 }, text: 'رصيد أحمد خالد', from: {} } }, { 'X-Telegram-Bot-Api-Secret-Token': 'real-secret' }), envWithSecret);
  assert('بـsecret_token الصحيح: الطلب يُعالَج بشكل طبيعي', res2.status === 200);
})().then(() => summary()).catch(e => { console.error(e); process.exitCode = 1; });

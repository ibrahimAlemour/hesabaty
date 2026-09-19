// طبقة تخزين عن بعد باستخدام Supabase (تُستخدم فقط إذا تم إعداد المشروع من الإعدادات)
// تعرض نفس واجهة db-indexeddb.js (getAll, getById, put, remove, getByIndex) لتسهيل التبديل بينهما
// تحذير أمني: لا تضع هنا سوى Supabase URL و anon key العلنيين. لا تستخدم Service Role Key هنا أبدًا.

let supabaseClient = null;

// تحويل اسم المخزن المحلي إلى اسم الجدول في Supabase
const TABLE_MAP = {
  settings: 'app_settings',
  customers: 'customers',
  categories: 'categories',
  products: 'products',
  sales: 'sales',
  saleItems: 'sale_items',
  payments: 'payments',
  expenses: 'expenses',
  cashTransactions: 'cash_transactions',
  auditLog: 'audit_log',
  syncQueue: null // قائمة المزامنة تبقى محلية دائمًا ولا تُرفع لسوبابيس
};

export function isSupabaseConfigured(config) {
  return !!(config && config.url && config.anonKey);
}

export async function initSupabaseClient(config) {
  if (!isSupabaseConfigured(config)) { supabaseClient = null; return null; }
  if (supabaseClient && supabaseClient.__url === config.url) return supabaseClient;
  // مكتبة supabase-js تُحمّل من CDN عبر index.html فقط عند تفعيل الاتصال (window.supabase)
  if (!window.supabase || !window.supabase.createClient) {
    throw new Error('مكتبة Supabase غير محمّلة');
  }
  supabaseClient = window.supabase.createClient(config.url, config.anonKey);
  supabaseClient.__url = config.url;
  return supabaseClient;
}

export function getClient() { return supabaseClient; }

function tableOf(storeName) {
  const t = TABLE_MAP[storeName];
  if (!t) throw new Error(`الجدول ${storeName} غير متاح على سوبابيس`);
  return t;
}

export async function getAll(storeName) {
  const table = tableOf(storeName);
  const { data, error } = await supabaseClient.from(table).select('*');
  if (error) throw error;
  return data || [];
}

export async function getById(storeName, id) {
  const table = tableOf(storeName);
  const { data, error } = await supabaseClient.from(table).select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function put(storeName, record) {
  const table = tableOf(storeName);
  const { data, error } = await supabaseClient.from(table).upsert(record).select().maybeSingle();
  if (error) throw error;
  return data || record;
}

export async function bulkPut(storeName, records) {
  const table = tableOf(storeName);
  if (!records.length) return;
  const { error } = await supabaseClient.from(table).upsert(records);
  if (error) throw error;
}

export async function remove(storeName, id) {
  const table = tableOf(storeName);
  const { error } = await supabaseClient.from(table).delete().eq('id', id);
  if (error) throw error;
}

export async function getByIndex(storeName, column, value) {
  const table = tableOf(storeName);
  const { data, error } = await supabaseClient.from(table).select('*').eq(column, value);
  if (error) throw error;
  return data || [];
}

// نتحقق من صحة الرابط والمفتاح عبر عميل supabase-js نفسه (يضبط الترويسات الصحيحة تلقائيًا)
// نستعلم جدول categories: لو رجع خطأ "صلاحيات" (RLS) فهذا يعني أن الاتصال سليم والجداول موجودة، فقط غير مسجّل دخول بعد - وهذا متوقع وطبيعي هنا
export async function testConnection(config) {
  try {
    if (!isSupabaseConfigured(config)) throw new Error('أدخل الرابط والمفتاح');
    const client = await initSupabaseClient(config);
    const { error } = await client.from('categories').select('id').limit(1);
    if (error) {
      const msg = (error.message || '').toLowerCase();
      const isRlsBlock = error.code === '42501' || msg.includes('permission denied') || msg.includes('rls') || msg.includes('row-level security');
      if (!isRlsBlock) throw new Error(error.message || 'تعذر الاتصال بقاعدة البيانات');
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}

// المصادقة (Supabase Auth)
export async function signIn(email, password) {
  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}
export async function signOut() {
  if (supabaseClient) await supabaseClient.auth.signOut();
}
export async function getSession() {
  if (!supabaseClient) return null;
  const { data } = await supabaseClient.auth.getSession();
  return data.session;
}

// يجدد رمز الجلسة صراحة (لا يعتمد على مؤقّت التجديد التلقائي الداخلي لمكتبة سوبابيس، والذي قد لا يعمل
// إذا بقي التطبيق بالخلفية لفترة طويلة على الجوال فتنتهي صلاحية الجلسة دون تجديد قبل أول طلب كتابة جديد)
export async function refreshSession() {
  if (!supabaseClient) return null;
  const { data, error } = await supabaseClient.auth.refreshSession();
  if (error) return null;
  return data.session;
}

// جدول profiles: يربط مستخدم Supabase Auth بالاسم والدور (owner/cashier/super_admin) والمحل التابع له
export async function getProfile(userId) {
  const { data, error } = await supabaseClient.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  return data || null;
}

// بيانات المحل (للتحقق من حالة التعليق) ورسالة التواصل العامة
export async function getShop(shopId) {
  if (!shopId) return null;
  const { data, error } = await supabaseClient.from('shops').select('*').eq('id', shopId).maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getAdminSettings() {
  const { data, error } = await supabaseClient.from('admin_settings').select('*').eq('id', 'global').maybeSingle();
  if (error) throw error;
  return data || null;
}

// تحميل مكتبة supabase-js من CDN مرة واحدة فقط عند الحاجة
let supabaseScriptPromise = null;
export function loadSupabaseScript() {
  if (window.supabase && window.supabase.createClient) return Promise.resolve();
  if (supabaseScriptPromise) return supabaseScriptPromise;
  supabaseScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
    script.onload = resolve;
    script.onerror = () => { supabaseScriptPromise = null; reject(new Error('فشل تحميل مكتبة Supabase')); };
    document.head.appendChild(script);
  });
  return supabaseScriptPromise;
}

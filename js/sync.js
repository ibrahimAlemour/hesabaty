// طابور المزامنة: يضمن عدم فقدان العمليات عند انقطاع الإنترنت وعدم تكرارها عند الاتصال
import * as localDb from './db-indexeddb.js';
import * as remoteDb from './db-supabase.js';
import { uuid, nowISO } from './utils.js';
import { toastWarning, toastSuccess } from './ui.js';

let syncing = false;
const listeners = [];

export function onSyncStatusChange(cb) {
  listeners.push(cb);
  return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
}
function notify(status) { listeners.forEach(cb => cb(status)); }

export async function enqueue(storeName, operation, payload) {
  const item = { id: uuid(), storeName, operation, payload, created_at: nowISO(), attempts: 0 };
  await localDb.put('syncQueue', item);
  notify('pending');
  return item;
}

export async function getPendingCount() {
  const items = await localDb.getAll('syncQueue');
  return items.length;
}

// تفاصيل العمليات العالقة (تُستخدم بشاشة الإعدادات لعرض سبب تعثر المزامنة عند وجود خطأ حقيقي وليس مجرد انقطاع إنترنت)
export async function getPendingItems() {
  const items = await localDb.getAll('syncQueue');
  return items.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// معرّفات السجلات إلي لسا بانتظار الرفع لسوبابيس (تُستخدم لتمييزها بشارة "غير متزامن" بالواجهة)
export async function getPendingIds(storeName) {
  const items = await localDb.getAll('syncQueue');
  return new Set(items.filter(i => i.storeName === storeName && i.payload).map(i => i.payload.id));
}

// الحالة الحالية للمزامنة عند فتح التطبيق أو تغيير الشاشة، قبل وصول أي حدث جديد
export async function getSyncStatus() {
  if (!navigator.onLine) return 'offline';
  const pending = await getPendingCount();
  return pending ? 'pending' : 'synced';
}

// يعيد تهيئة عميل سوبابيس إذا لم يكن جاهزًا بعد (مثلاً لأن التطبيق فُتح أول مرة أوف لاين ولم تتحمّل مكتبة سوبابيس)
// ثم يتأكد أن جلسة الدخول صالحة وغير منتهية قبل أي محاولة رفع.
// السبب: مؤقّت التجديد التلقائي لمكتبة سوبابيس قد يتوقف عن العمل إذا بقي التطبيق بالخلفية على الجوال
// لفترة طويلة (المتصفح يجمّد المؤقّتات بالخلفية)، فتنتهي صلاحية الجلسة دون تجديد، وأي طلب كتابة بعدها
// يُرفض بصمت بسياسة RLS (Row Level Security) رغم أن المستخدم يبدو "مسجّل دخوله" بواجهة التطبيق
async function ensureRemoteClient() {
  try {
    if (!remoteDb.getClient()) {
      const settings = await localDb.getById('settings', 'app');
      if (!settings || settings.backendMode !== 'supabase' || !settings.supabaseUrl || !settings.supabaseAnonKey) return false;
      await remoteDb.loadSupabaseScript();
      await remoteDb.initSupabaseClient({ url: settings.supabaseUrl, anonKey: settings.supabaseAnonKey });
    }
    if (!remoteDb.getClient()) return false;

    let session = await remoteDb.getSession();
    const expiresAtMs = session?.expires_at ? session.expires_at * 1000 : 0;
    if (!session || expiresAtMs < Date.now() + 60000) {
      session = await remoteDb.refreshSession();
    }
    return !!session;
  } catch (e) {
    return false;
  }
}

export async function flushQueue() {
  if (syncing) return;
  if (!navigator.onLine) return;
  if (!(await ensureRemoteClient())) return;
  syncing = true;
  notify('syncing');
  try {
    const items = await localDb.getAll('syncQueue');
    items.sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const item of items) {
      try {
        if (item.operation === 'put') {
          await remoteDb.put(item.storeName, item.payload);
        } else if (item.operation === 'remove') {
          await remoteDb.remove(item.storeName, item.payload.id);
        }
        await localDb.remove('syncQueue', item.id);
      } catch (err) {
        item.attempts = (item.attempts || 0) + 1;
        item.lastError = err.message || String(err);
        await localDb.put('syncQueue', item);
        if (item.attempts >= 5) {
          console.error('فشلت مزامنة عملية بعد عدة محاولات', item, err);
        }
        break; // نحافظ على الترتيب: نوقف المزامنة عند أول فشل حتى لا تختل الحركات
      }
    }
    const remaining = await getPendingCount();
    notify(remaining ? 'pending' : 'synced');
    if (remaining === 0 && items.length) toastSuccess('تمت مزامنة جميع العمليات مع الخادم');
  } finally {
    syncing = false;
  }
}

export function initAutoSync() {
  window.addEventListener('online', () => {
    toastWarning('تم استعادة الاتصال، جاري المزامنة...');
    flushQueue();
  });
  window.addEventListener('offline', () => notify('offline'));
  setInterval(() => { if (navigator.onLine) flushQueue(); }, 30000);
}

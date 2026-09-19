// طبقة الوصول لبيانات SaaS (المحلات، الاشتراكات، الدفعات) - لوحة المدير العام فقط
import { loadSupabaseScript, initSupabaseClient, getClient, signIn, signOut, getSession, getProfile } from '../../js/db-supabase.js';
import { SAAS_SUPABASE_URL, SAAS_SUPABASE_ANON_KEY } from '../../js/saas-config.js';
import { uuid, nowISO } from '../../js/utils.js';

export { signIn, signOut, getSession, getProfile };

export async function ensureClient() {
  if (getClient()) return getClient();
  await loadSupabaseScript();
  return initSupabaseClient({ url: SAAS_SUPABASE_URL, anonKey: SAAS_SUPABASE_ANON_KEY });
}

function client() {
  const c = getClient();
  if (!c) throw new Error('لم يتم تهيئة الاتصال بقاعدة البيانات بعد');
  return c;
}

// ---------- المحلات ----------
export async function listShops() {
  const { data, error } = await client().from('shops').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getShop(id) {
  const { data, error } = await client().from('shops').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function createShop({ name, ownerName, phone, address, status }) {
  const { data, error } = await client().from('shops').insert({
    name, owner_name: ownerName || '', phone: phone || '', address: address || '', status: status || 'pending'
  }).select().single();
  if (error) throw error;
  return data;
}

export async function updateShop(id, patch) {
  const { data, error } = await client().from('shops').update({ ...patch, updated_at: nowISO() }).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function setShopStatus(id, status) {
  return updateShop(id, { status });
}

// ---------- الاشتراكات ----------
export async function getShopSubscriptions(shopId) {
  const { data, error } = await client().from('subscriptions').select('*').eq('shop_id', shopId).order('end_date', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getLatestSubscription(shopId) {
  const rows = await getShopSubscriptions(shopId);
  return rows[0] || null;
}

export async function getAllLatestSubscriptions() {
  const { data, error } = await client().from('subscriptions').select('*').order('end_date', { ascending: false });
  if (error) throw error;
  const byShop = new Map();
  for (const row of data || []) if (!byShop.has(row.shop_id)) byShop.set(row.shop_id, row);
  return byShop;
}

export async function addSubscriptionPeriod({ shopId, monthlyPrice, startDate, endDate, notes }) {
  const { data, error } = await client().from('subscriptions').insert({
    shop_id: shopId, monthly_price: monthlyPrice, start_date: startDate, end_date: endDate, notes: notes || ''
  }).select().single();
  if (error) throw error;
  return data;
}

// ---------- دفعات الاشتراك ----------
export async function getShopPayments(shopId) {
  const { data, error } = await client().from('subscription_payments').select('*').eq('shop_id', shopId).order('paid_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getAllPayments() {
  const { data, error } = await client().from('subscription_payments').select('*').order('paid_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function addPayment({ shopId, subscriptionId, amount, method, periodFrom, periodTo, notes }) {
  const { data, error } = await client().from('subscription_payments').insert({
    shop_id: shopId, subscription_id: subscriptionId || null, amount, method: method || 'cash',
    period_from: periodFrom || null, period_to: periodTo || null, notes: notes || ''
  }).select().single();
  if (error) throw error;
  return data;
}

// ---------- إعدادات النظام العامة ----------
export async function getAdminSettings() {
  const { data, error } = await client().from('admin_settings').select('*').eq('id', 'global').maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateAdminSettings(patch) {
  const { data, error } = await client().from('admin_settings').update({ ...patch, updated_at: nowISO() }).eq('id', 'global').select().single();
  if (error) throw error;
  return data;
}

// ---------- سجل تدقيق العمليات الإدارية ----------
export async function logAdminAction(admin, action, targetShopId, changes) {
  const { error } = await client().from('admin_audit_log').insert({
    admin_id: admin ? admin.id : null, admin_name: admin ? admin.name : '', action,
    target_shop_id: targetShopId || null, changes: changes || {}
  });
  if (error) console.error('فشل تسجيل سجل التدقيق', error);
}

export async function getAuditLog(limit = 50) {
  const { data, error } = await client().from('admin_audit_log').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

// يشغّل فحص تعليق المحلات منتهية الاشتراك تلقائيًا (Postgres function)
export async function runAutoSuspendCheck() {
  const { data, error } = await client().rpc('check_and_suspend_expired_shops');
  if (error) { console.error('فشل فحص التعليق التلقائي', error); return 0; }
  return data || 0;
}

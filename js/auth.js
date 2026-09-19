// مصادقة مبسطة: حساب محلي مع تشفير كلمة مرور بسيط عبر SHA-256، أو Supabase Auth عند التفعيل
import { getSettings, updateSettings } from './database.js';
import { uuid } from './utils.js';
import * as remoteDb from './db-supabase.js';

async function hashPassword(password) {
  const enc = new TextEncoder().encode(password);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const SESSION_KEY = 'hesabaty_session';

export async function createOwnerAccount({ name, email, password }) {
  const settings = await getSettings();
  const passwordHash = await hashPassword(password);
  const user = { id: uuid(), name, email: email || '', passwordHash, role: 'owner' };
  const users = [...(settings.users || []).filter(u => u.role !== 'owner'), user];
  await updateSettings({ users, currentUser: { id: user.id, name: user.name, role: 'owner' } });
  sessionStorage.setItem(SESSION_KEY, user.id);
  return user;
}

export async function addCashierAccount({ name, pin }) {
  const settings = await getSettings();
  const passwordHash = await hashPassword(pin);
  const user = { id: uuid(), name, passwordHash, role: 'cashier' };
  const users = [...(settings.users || []), user];
  await updateSettings({ users });
  return user;
}

export async function removeUser(userId) {
  const settings = await getSettings();
  const users = (settings.users || []).filter(u => u.id !== userId);
  await updateSettings({ users });
}

export async function localSignIn(identifier, password) {
  const settings = await getSettings();
  const passwordHash = await hashPassword(password);
  const user = (settings.users || []).find(u => (u.email === identifier || u.name === identifier) && u.passwordHash === passwordHash);
  if (!user) throw new Error('بيانات تسجيل الدخول غير صحيحة');
  await updateSettings({ currentUser: { id: user.id, name: user.name, role: user.role } });
  sessionStorage.setItem(SESSION_KEY, user.id);
  return user;
}

export async function pinSignIn(userId, pin) {
  const settings = await getSettings();
  const passwordHash = await hashPassword(pin);
  const user = (settings.users || []).find(u => u.id === userId && u.passwordHash === passwordHash);
  if (!user) throw new Error('رمز الدخول غير صحيح');
  await updateSettings({ currentUser: { id: user.id, name: user.name, role: user.role } });
  sessionStorage.setItem(SESSION_KEY, user.id);
  return user;
}

// تسجيل الدخول عبر Supabase Auth: يُستخدم فقط عندما يكون التطبيق متصلاً بسوبابيس (backendMode = 'supabase')
// يتطلب أن يكون المستخدم قد أُنشئ مسبقًا من لوحة Supabase مع صف مطابق بجدول profiles
export async function supabaseSignIn(email, password) {
  await remoteDb.signIn(email, password);
  const session = await remoteDb.getSession();
  if (!session) throw new Error('تعذر تسجيل الدخول');
  const profile = await remoteDb.getProfile(session.user.id);
  if (!profile) {
    await remoteDb.signOut();
    throw new Error('لا يوجد ملف تعريف (profile) لهذا الحساب بجدول profiles. أضف صفًا بنفس الـ UID من لوحة Supabase.');
  }
  if (profile.role === 'super_admin') {
    await remoteDb.signOut();
    throw new Error('هذا حساب مدير عام. استخدم لوحة المدير العام (admin) بدل تطبيق المحل.');
  }

  let shopStatus = 'active';
  if (profile.shop_id) {
    const shop = await remoteDb.getShop(profile.shop_id);
    if (!shop) {
      await remoteDb.signOut();
      throw new Error('تعذر العثور على بيانات المحل المرتبط بهذا الحساب.');
    }
    shopStatus = shop.status;
  }

  const user = { id: profile.id, name: profile.name, role: profile.role };
  await updateSettings({ currentUser: user, currentShopId: profile.shop_id || null, shopStatus });
  sessionStorage.setItem(SESSION_KEY, user.id);
  return user;
}

// يُستدعى عند كل فتح للتطبيق (وضع سوبابيس) للتأكد أن حالة تعليق المحل محدّثة
export async function refreshShopStatus() {
  const settings = await getSettings();
  if (settings.backendMode !== 'supabase' || !settings.currentShopId) return settings.shopStatus || 'active';
  try {
    const shop = await remoteDb.getShop(settings.currentShopId);
    const status = shop ? shop.status : 'active';
    await updateSettings({ shopStatus: status });
    return status;
  } catch (e) {
    return settings.shopStatus || 'active';
  }
}

export async function signOut() {
  sessionStorage.removeItem(SESSION_KEY);
  await updateSettings({ currentUser: null, currentShopId: null, shopStatus: 'active' });
  try { await remoteDb.signOut(); } catch (e) { /* لا يوجد اتصال سوبابيس نشط */ }
}

export async function getCurrentUser() {
  const settings = await getSettings();
  return settings.currentUser || null;
}

export async function isLoggedIn() {
  const settings = await getSettings();
  if (!settings.setupCompleted) return false;
  if (settings.backendMode === 'supabase') {
    const session = await remoteDb.getSession();
    return !!session && !!settings.currentUser;
  }
  return !!settings.currentUser && !!sessionStorage.getItem(SESSION_KEY);
}

export function hasRole(user, ...roles) {
  return !!user && roles.includes(user.role);
}

export function canViewProfit(user) {
  return !user || user.role === 'owner';
}

export function canDelete(user) {
  return !user || user.role === 'owner';
}

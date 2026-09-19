// مصادقة لوحة المدير العام: تسجيل دخول عبر Supabase Auth فقط، مع التحقق من role = 'super_admin'
import * as adb from './admin-db.js';

let cachedAdmin = null;

export async function adminSignIn(email, password) {
  await adb.ensureClient();
  await adb.signIn(email, password);
  const session = await adb.getSession();
  if (!session) throw new Error('تعذر تسجيل الدخول');
  const profile = await adb.getProfile(session.user.id);
  if (!profile || profile.role !== 'super_admin') {
    await adb.signOut();
    throw new Error('هذا الحساب لا يملك صلاحية المدير العام');
  }
  cachedAdmin = profile;
  return profile;
}

export async function getCurrentAdmin() {
  if (cachedAdmin) return cachedAdmin;
  try {
    await adb.ensureClient();
    const session = await adb.getSession();
    if (!session) return null;
    const profile = await adb.getProfile(session.user.id);
    if (!profile || profile.role !== 'super_admin') return null;
    cachedAdmin = profile;
    return profile;
  } catch (e) {
    console.error('تعذر التحقق من جلسة المدير', e);
    return null;
  }
}

export async function isAdminLoggedIn() {
  return !!(await getCurrentAdmin());
}

export async function adminSignOut() {
  cachedAdmin = null;
  await adb.signOut();
}

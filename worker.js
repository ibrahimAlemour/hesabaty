// Cloudflare Worker: يخدم ملفات التطبيق الثابتة، ويضيف مسار API واحد فقط لإنشاء محل جديد بحساب دخول جاهز
// هذا هو المكان الوحيد المسموح فيه استخدام SUPABASE_SERVICE_ROLE_KEY - لا يصل هذا المفتاح للمتصفح أبدًا
// المفتاح يُقرأ من متغير بيئة سرّي (Cloudflare Secret)، وليس مكتوبًا هنا أو بأي ملف بالمستودع

const SUPABASE_URL = 'https://nopgzklztwpawuzirtae.supabase.co';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/admin/create-shop') {
      return handleCreateShop(request, env);
    }
    if (url.pathname === '/api/admin/delete-shop') {
      return handleDeleteShop(request, env);
    }
    if (url.pathname === '/api/admin/get-owner-email') {
      return handleGetOwnerEmail(request, env);
    }
    if (url.pathname === '/api/admin/reset-owner-password') {
      return handleResetOwnerPassword(request, env);
    }
    if (url.pathname === '/api/admin/run-backup-now') {
      return handleRunBackupNow(request, env);
    }
    if (url.pathname === '/api/admin/backup-status') {
      return handleBackupStatus(request, env);
    }
    if (url.pathname === '/api/shop/create-cashier') {
      return handleCreateCashier(request, env);
    }
    if (url.pathname === '/api/shop/delete-cashier') {
      return handleDeleteCashier(request, env);
    }
    if (url.pathname === '/api/shop/get-cashier-email') {
      return handleGetCashierEmail(request, env);
    }
    if (url.pathname === '/api/shop/reset-cashier-password') {
      return handleResetCashierPassword(request, env);
    }
    return env.ASSETS.fetch(request);
  },

  // يُستدعى تلقائيًا حسب جدولَي cron المضبوطَين بـ wrangler.toml: كل 15 دقيقة لفحص جدولات SMS المستحقة،
  // ومرة واحدة يوميًا (1 صباحًا UTC) لتنفيذ نسخة احتياطية كاملة - نفرّق بينهما عبر event.cron
  async scheduled(event, env, ctx) {
    if (event.cron === '0 1 * * *') {
      ctx.waitUntil(runDailyBackup(env));
    } else {
      ctx.waitUntil(processDueSmsSchedules(env));
    }
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

// يتحقق أن الطلب صادر فعلاً من مستخدم مسجّل دخوله بدور super_admin، ويرجع مفتاح الخدمة السري للاستخدام لاحقًا
// يُستدعى في بداية كل مسار إداري حساس (إنشاء/حذف محل) قبل أي عملية أخرى
async function requireSuperAdmin(request, env) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return { error: json({ error: 'الخادم غير مهيأ بعد: أضف SUPABASE_SERVICE_ROLE_KEY كسرّ (Secret) من إعدادات Cloudflare Workers' }, 500) };

  const authHeader = request.headers.get('Authorization') || '';
  const callerToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!callerToken) return { error: json({ error: 'غير مصرح: لا يوجد رمز جلسة' }, 401) };

  // نتحقق من هوية المتصل عبر رمز جلسته الحقيقي (وليس المفتاح السري) حتى نتأكد أنه فعلاً هو المسجّل دخوله
  const callerRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${callerToken}` }
  });
  if (!callerRes.ok) return { error: json({ error: 'جلسة الدخول غير صالحة، سجّل الدخول من جديد' }, 401) };
  const callerUser = await callerRes.json();

  const svcHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  // نتأكد أن المتصل نفسه مسجّل بجدول profiles بدور super_admin (نستعلم بالمفتاح السري فنتجاوز RLS بأمان هنا فقط)
  const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${callerUser.id}&select=role`, { headers: svcHeaders });
  const callerProfiles = await profileRes.json();
  if (!Array.isArray(callerProfiles) || !callerProfiles.length || callerProfiles[0].role !== 'super_admin') {
    return { error: json({ error: 'هذا الحساب لا يملك صلاحية المدير العام' }, 403) };
  }

  return { serviceKey, svcHeaders };
}

// يتحقق أن الطلب صادر من مستخدم مسجّل دخوله فعليًا بدور owner لمحل حقيقي، ويرجع shop_id الخاص به - يُستخدم قبل
// أي عملية تخص حسابات الكاشير (إنشاء/حذف)، لأنها تتطلب مفتاح service_role (إنشاء/حذف حساب Supabase Auth)
// ولا يمكن فعلها مباشرة من متصفح صاحب المحل بمفتاح anon العادي
async function requireShopOwner(request, env) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return { error: json({ error: 'الخادم غير مهيأ بعد: أضف SUPABASE_SERVICE_ROLE_KEY كسرّ (Secret) من إعدادات Cloudflare Workers' }, 500) };

  const authHeader = request.headers.get('Authorization') || '';
  const callerToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!callerToken) return { error: json({ error: 'غير مصرح: لا يوجد رمز جلسة' }, 401) };

  const callerRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${callerToken}` }
  });
  if (!callerRes.ok) return { error: json({ error: 'جلسة الدخول غير صالحة، سجّل الدخول من جديد' }, 401) };
  const callerUser = await callerRes.json();

  const svcHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${callerUser.id}&select=role,shop_id`, { headers: svcHeaders });
  const callerProfiles = await profileRes.json();
  const callerProfile = Array.isArray(callerProfiles) ? callerProfiles[0] : null;
  if (!callerProfile || callerProfile.role !== 'owner' || !callerProfile.shop_id) {
    return { error: json({ error: 'هذا الحساب لا يملك صلاحية صاحب المحل' }, 403) };
  }

  return { serviceKey, svcHeaders, shopId: callerProfile.shop_id };
}

// إنشاء حساب كاشير حقيقي (بريد إلكتروني + كلمة مرور) مرتبط بمحل صاحب الحساب المتصل تحديدًا، بدور 'cashier'
async function handleCreateCashier(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const auth = await requireShopOwner(request, env);
  if (auth.error) return auth.error;
  const { svcHeaders, shopId } = auth;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'بيانات الطلب غير صالحة' }, 400); }
  const { name, email, password } = body || {};

  if (!name || !String(name).trim()) return json({ error: 'أدخل اسم الكاشير' }, 400);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'أدخل بريدًا إلكترونيًا صحيحًا' }, 400);
  if (!password || String(password).length < 6) return json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' }, 400);

  const createUserRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST', headers: svcHeaders,
    body: JSON.stringify({ email, password, email_confirm: true })
  });
  const newUser = await createUserRes.json();
  if (!createUserRes.ok) {
    return json({ error: newUser.msg || newUser.error_description || newUser.message || 'فشل إنشاء حساب الدخول (ربما البريد مستخدم من قبل)' }, 400);
  }

  const profileRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
    method: 'POST', headers: { ...svcHeaders, Prefer: 'return=representation' },
    body: JSON.stringify({ id: newUser.id, name: String(name).trim(), role: 'cashier', shop_id: shopId })
  });
  if (!profileRes.ok) {
    // نحذف حساب الدخول فورًا لو فشل إنشاء صف profiles، حتى لا يبقى حساب دخول معلّق بلا صف مرتبط به
    await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${newUser.id}`, { method: 'DELETE', headers: svcHeaders });
    return json({ error: 'فشل إنشاء ملف تعريف الكاشير' }, 500);
  }

  return json({ email, password });
}

// حذف حساب كاشير نهائيًا - نتأكد أولاً أنه ينتمي فعليًا لنفس محل صاحب الحساب المتصل (لا يمرّر أي id عشوائي)
// يتأكد أن cashierId فعلاً حساب كاشير تابع لنفس محل صاحب الحساب المتصل - يمنع أي تمرير يدوي لـid حساب بمحل آخر.
// تُستخدم قبل أي عملية تخص حساب كاشير محدَّد (حذف/عرض بريد/تغيير كلمة مرور)
async function verifyCashierOwnership(cashierId, shopId, svcHeaders) {
  const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${cashierId}&select=shop_id,role`, { headers: svcHeaders });
  const rows = await checkRes.json();
  const target = Array.isArray(rows) ? rows[0] : null;
  return !!(target && target.shop_id === shopId && target.role === 'cashier');
}

async function handleDeleteCashier(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const auth = await requireShopOwner(request, env);
  if (auth.error) return auth.error;
  const { svcHeaders, shopId } = auth;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'بيانات الطلب غير صالحة' }, 400); }
  const { cashierId } = body || {};
  if (!cashierId) return json({ error: 'معرّف الكاشير مفقود' }, 400);

  if (!(await verifyCashierOwnership(cashierId, shopId, svcHeaders))) {
    return json({ error: 'هذا الحساب غير موجود أو لا ينتمي لمحلك' }, 404);
  }

  const deleteRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${cashierId}`, { method: 'DELETE', headers: svcHeaders });
  if (!deleteRes.ok) return json({ error: 'فشل حذف حساب الكاشير' }, 500);

  return json({ ok: true });
}

// يجلب بريد حساب كاشير معيّن (مخزّن فقط بنظام Supabase Auth، غير موجود بجدول profiles، فلا يمكن قراءته إلا هنا)
async function handleGetCashierEmail(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const auth = await requireShopOwner(request, env);
  if (auth.error) return auth.error;
  const { svcHeaders, shopId } = auth;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'بيانات الطلب غير صالحة' }, 400); }
  const { cashierId } = body || {};
  if (!cashierId) return json({ error: 'معرّف الكاشير مفقود' }, 400);

  if (!(await verifyCashierOwnership(cashierId, shopId, svcHeaders))) {
    return json({ error: 'هذا الحساب غير موجود أو لا ينتمي لمحلك' }, 404);
  }

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${cashierId}`, { headers: svcHeaders });
  const userData = await userRes.json();
  if (!userRes.ok) return json({ error: userData.msg || 'فشل جلب بيانات الحساب' }, 500);

  return json({ email: userData.email || '' });
}

// يعيّن كلمة مرور جديدة لحساب كاشير. كلمة المرور القديمة غير قابلة للاسترجاع أبدًا (مُخزَّنة مُشفّرة) - الحل الوحيد تعيين كلمة جديدة
async function handleResetCashierPassword(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const auth = await requireShopOwner(request, env);
  if (auth.error) return auth.error;
  const { svcHeaders, shopId } = auth;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'بيانات الطلب غير صالحة' }, 400); }
  const { cashierId, newPassword } = body || {};
  if (!cashierId) return json({ error: 'معرّف الكاشير مفقود' }, 400);
  if (!newPassword || String(newPassword).length < 6) return json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' }, 400);

  if (!(await verifyCashierOwnership(cashierId, shopId, svcHeaders))) {
    return json({ error: 'هذا الحساب غير موجود أو لا ينتمي لمحلك' }, 404);
  }

  const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${cashierId}`, {
    method: 'PUT', headers: svcHeaders, body: JSON.stringify({ password: newPassword })
  });
  const updateData = await updateRes.json();
  if (!updateRes.ok) return json({ error: updateData.msg || 'فشل تحديث كلمة المرور' }, 500);

  return json({ ok: true });
}

async function handleCreateShop(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const auth = await requireSuperAdmin(request, env);
  if (auth.error) return auth.error;
  const { svcHeaders } = auth;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'بيانات الطلب غير صالحة' }, 400); }
  const { shopName, ownerName, phone, address, monthlyPrice, months, ownerEmail, ownerPassword } = body || {};

  if (!shopName || !String(shopName).trim()) return json({ error: 'أدخل اسم المحل' }, 400);
  if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) return json({ error: 'أدخل بريدًا إلكترونيًا صحيحًا' }, 400);
  if (!ownerPassword || String(ownerPassword).length < 6) return json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' }, 400);

  // 1) إنشاء حساب الدخول عبر Supabase Auth Admin API
  const createUserRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST', headers: svcHeaders,
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword, email_confirm: true })
  });
  const newUser = await createUserRes.json();
  if (!createUserRes.ok) {
    return json({ error: newUser.msg || newUser.error_description || newUser.message || 'فشل إنشاء حساب الدخول (ربما البريد مستخدم من قبل)' }, 400);
  }

  // 2) إنشاء صف المحل
  const shopRes = await fetch(`${SUPABASE_URL}/rest/v1/shops`, {
    method: 'POST', headers: { ...svcHeaders, Prefer: 'return=representation' },
    body: JSON.stringify({
      name: String(shopName).trim(), owner_name: ownerName || '', phone: phone || '', address: address || '', status: 'active'
    })
  });
  const shopRows = await shopRes.json();
  if (!shopRes.ok || !Array.isArray(shopRows) || !shopRows.length) {
    return json({ error: 'فشل إنشاء المحل بعد إنشاء حساب الدخول. راجع لوحة Supabase يدويًا.' }, 500);
  }
  const shop = shopRows[0];

  // 3) إنشاء فترة الاشتراك الأولى
  const start = new Date();
  const end = new Date();
  end.setMonth(end.getMonth() + (parseInt(months) || 1));
  await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
    method: 'POST', headers: svcHeaders,
    body: JSON.stringify({
      shop_id: shop.id,
      monthly_price: Math.round((parseFloat(monthlyPrice) || 0) * 100),
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10)
    })
  });

  // 4) ربط حساب الدخول بالمحل داخل جدول profiles
  await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
    method: 'POST', headers: svcHeaders,
    body: JSON.stringify({ id: newUser.id, name: ownerName || String(shopName).trim(), role: 'owner', shop_id: shop.id })
  });

  // 5) تهيئة إعدادات المحل (اسم المحل، الهاتف...) حتى تظهر صحيحة فور أول تسجيل دخول بدل القيم الافتراضية
  await fetch(`${SUPABASE_URL}/rest/v1/app_settings`, {
    method: 'POST', headers: svcHeaders,
    body: JSON.stringify({
      id: shop.id, shop_id: shop.id, shop_name: String(shopName).trim(), phone: phone || '', address: address || '',
      currency: '₪', timezone: 'Asia/Gaza'
    })
  });

  return json({ shop, ownerEmail, ownerPassword });
}

// حذف محل نهائيًا: يحذف حسابات الدخول المرتبطة به عبر Auth Admin API، ثم صف المحل نفسه
// (يحذف قاعدة البيانات تلقائيًا كل بيانات المحل المرتبطة عبر ON DELETE CASCADE - راجع schema_saas.sql القسم 8)
async function handleDeleteShop(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const auth = await requireSuperAdmin(request, env);
  if (auth.error) return auth.error;
  const { svcHeaders } = auth;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'بيانات الطلب غير صالحة' }, 400); }
  const { shopId } = body || {};
  if (!shopId) return json({ error: 'معرّف المحل مفقود' }, 400);

  // نجلب كل حسابات الدخول المرتبطة بهذا المحل لحذفها من نظام المصادقة أيضًا
  const profilesRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?shop_id=eq.${shopId}&select=id`, { headers: svcHeaders });
  const linkedProfiles = await profilesRes.json();

  if (Array.isArray(linkedProfiles)) {
    for (const p of linkedProfiles) {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${p.id}`, { method: 'DELETE', headers: svcHeaders });
    }
  }

  // حذف صف المحل نفسه يحذف تلقائيًا كل بياناته المرتبطة (customers/products/sales/...) عبر Cascade
  const deleteRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${shopId}`, { method: 'DELETE', headers: svcHeaders });
  if (!deleteRes.ok) {
    const errBody = await deleteRes.json().catch(() => ({}));
    return json({ error: errBody.message || 'فشل حذف المحل' }, 500);
  }

  return json({ ok: true });
}

// يجلب معرّف حساب صاحب المحل (profile بدور owner مرتبط بهذا shop_id) - يُستخدم من الدالتين التاليتين
async function findOwnerProfileId(shopId, svcHeaders) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?shop_id=eq.${shopId}&role=eq.owner&select=id&limit=1`, { headers: svcHeaders });
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0].id : null;
}

// يعيد بريد صاحب المحل الحالي (مخزّن فقط بنظام Supabase Auth، غير موجود بجدول profiles، فلا يمكن قراءته إلا بمفتاح service_role هنا)
async function handleGetOwnerEmail(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const auth = await requireSuperAdmin(request, env);
  if (auth.error) return auth.error;
  const { svcHeaders } = auth;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'بيانات الطلب غير صالحة' }, 400); }
  const { shopId } = body || {};
  if (!shopId) return json({ error: 'معرّف المحل مفقود' }, 400);

  const ownerId = await findOwnerProfileId(shopId, svcHeaders);
  if (!ownerId) return json({ error: 'لا يوجد حساب مالك مرتبط بهذا المحل' }, 404);

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${ownerId}`, { headers: svcHeaders });
  const userData = await userRes.json();
  if (!userRes.ok) return json({ error: userData.msg || 'فشل جلب بيانات الحساب' }, 500);

  return json({ email: userData.email || '' });
}

// يُعيّن كلمة مرور جديدة لحساب صاحب المحل. ملاحظة أمنية مهمة: كلمة المرور القديمة غير قابلة للاسترجاع أبدًا
// (Supabase Auth يخزّنها مُجزّأة/hashed فقط، حتى نحن كمزوّد خدمة لا نستطيع قراءتها) - الحل الوحيد تعيين كلمة جديدة
async function handleResetOwnerPassword(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const auth = await requireSuperAdmin(request, env);
  if (auth.error) return auth.error;
  const { svcHeaders } = auth;

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'بيانات الطلب غير صالحة' }, 400); }
  const { shopId, newPassword } = body || {};
  if (!shopId) return json({ error: 'معرّف المحل مفقود' }, 400);
  if (!newPassword || String(newPassword).length < 6) return json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' }, 400);

  const ownerId = await findOwnerProfileId(shopId, svcHeaders);
  if (!ownerId) return json({ error: 'لا يوجد حساب مالك مرتبط بهذا المحل' }, 404);

  const updateRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${ownerId}`, {
    method: 'PUT', headers: svcHeaders, body: JSON.stringify({ password: newPassword })
  });
  const updateData = await updateRes.json();
  if (!updateRes.ok) return json({ error: updateData.msg || 'فشل تحديث كلمة المرور' }, 500);

  return json({ ok: true });
}

// ============================================================
// نظام النسخ الاحتياطي اليومي: يفرّغ كل الجداول الجوهرية (كل المحلات معًا) كملف JSON واحد يوميًا
// ويخزّنه بـ Cloudflare R2 - مزوّد منفصل تمامًا عن Supabase، فتبقى النسخة محمية حتى لو حصلت مشكلة
// بحساب Supabase نفسه (وليس فقط بصف أو جدول بداخله). لا تغطي هذه النسخة ملفات المرفقات نفسها
// (المخزّنة بـ Supabase Storage)، فقط صفوف الجداول (بما فيها صف attachments الذي يحوي مسار كل ملف)
// ============================================================

const BACKUP_TABLES = [
  'shops', 'profiles', 'app_settings', 'subscriptions',
  'categories', 'customers', 'products',
  'sales', 'sale_items', 'payments', 'expenses', 'cash_transactions',
  'suppliers', 'purchases', 'purchase_items', 'supplier_payments', 'attachments',
  'sms_templates', 'sms_schedules', 'sms_log'
];
const BACKUP_RETENTION_DAYS = 30;

// يجلب كل صفوف جدول عبر ترقيم صفحات (Range) بما أن Supabase REST تعيد 1000 صف كحد أقصى بالطلب الواحد افتراضيًا
async function fetchAllRows(table, svcHeaders) {
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*&order=id.asc`, {
      headers: { ...svcHeaders, Range: `${from}-${from + pageSize - 1}` }
    });
    if (!res.ok) throw new Error(`فشل جلب جدول ${table}: HTTP ${res.status}`);
    const page = await res.json();
    if (!Array.isArray(page) || !page.length) break;
    rows.push(...page);
    if (page.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function runDailyBackup(env) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) return { ok: false, error: 'السرّ SUPABASE_SERVICE_ROLE_KEY غير مضبوط' };
  if (!env.BACKUPS) return { ok: false, error: 'مساحة R2 (BACKUPS) غير مربوطة بهذا الـ Worker - راجع wrangler.toml وأنشئ الـ bucket' };
  const svcHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const dump = { generated_at: new Date().toISOString(), tables: {} };
  const counts = {};
  let hadError = false;
  for (const table of BACKUP_TABLES) {
    try {
      const rows = await fetchAllRows(table, svcHeaders);
      dump.tables[table] = rows;
      counts[table] = rows.length;
    } catch (e) {
      dump.tables[table] = [];
      counts[table] = `خطأ: ${e.message}`;
      hadError = true;
    }
  }

  const dateStr = dump.generated_at.slice(0, 10);
  const key = `daily/${dateStr}.json`;
  const body = JSON.stringify(dump);
  await env.BACKUPS.put(key, body);
  await pruneOldBackups(env);

  const status = { ok: !hadError, generated_at: dump.generated_at, key, size_bytes: body.length, counts };
  await env.BACKUPS.put('daily/latest-status.json', JSON.stringify(status));
  return status;
}

// يحذف النسخ الأقدم من BACKUP_RETENTION_DAYS يومًا فقط، حتى لا تتراكم المساحة إلى ما لا نهاية
async function pruneOldBackups(env) {
  const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const listed = await env.BACKUPS.list({ prefix: 'daily/' });
  for (const obj of listed.objects) {
    const m = obj.key.match(/daily\/(\d{4}-\d{2}-\d{2})\.json$/);
    if (m && new Date(m[1]).getTime() < cutoff) {
      await env.BACKUPS.delete(obj.key);
    }
  }
}

// يشغّل نسخة احتياطية فورية يدويًا (لاختبار الإعداد بدل انتظار الموعد اليومي) - صلاحية super_admin فقط
async function handleRunBackupNow(request, env) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const auth = await requireSuperAdmin(request, env);
  if (auth.error) return auth.error;
  const result = await runDailyBackup(env);
  return json(result, result.ok ? 200 : 500);
}

// يعرض حالة آخر نسخة احتياطية تمت (نجاح/فشل، الوقت، عدد صفوف كل جدول) - صلاحية super_admin فقط
async function handleBackupStatus(request, env) {
  const auth = await requireSuperAdmin(request, env);
  if (auth.error) return auth.error;
  if (!env.BACKUPS) return json({ error: 'مساحة R2 (BACKUPS) غير مربوطة بهذا الـ Worker' }, 500);
  const obj = await env.BACKUPS.get('daily/latest-status.json');
  if (!obj) return json({ error: 'لا يوجد أي نسخة احتياطية بعد' }, 404);
  return json(await obj.json());
}

// ============================================================
// نظام رسائل SMS: يفحص الجدولات المستحقة ويرسل تذكيرات الدين للزبائن المستهدفين
// هذا هو المكان الوحيد المسموح فيه استخدام مفتاح مزوّد SMS مستقبلًا (كسرّ Cloudflare أيضًا، بدون أي كود بالمتصفح)
// ============================================================

const CYCLE_DAYS = { weekly: 7, monthly: 30 };

async function processDueSmsSchedules(env) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) { console.error('SUPABASE_SERVICE_ROLE_KEY غير مضبوط - تعذّر فحص جدولات SMS'); return; }
  const svcHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  const nowIso = new Date().toISOString();
  const dueRes = await fetch(
    `${SUPABASE_URL}/rest/v1/sms_schedules?status=eq.pending&scheduled_at=lte.${encodeURIComponent(nowIso)}&select=*`,
    { headers: svcHeaders }
  );
  const due = await dueRes.json();
  if (!Array.isArray(due) || !due.length) return;

  for (const schedule of due) {
    try {
      // إصلاح أمني/مالي حرج: الحالة السابقة كانت تُحدَّث لـ"تم الإرسال" فقط بعد انتهاء إرسال كل الرسائل بنجاح
      // (حلقة تنتظر كل عملية بالتتابع). أي خطأ جزئي أثناء الحلقة (رقم هاتف تالف، خطأ شبكي عابر، تجاوز حد وقت
      // التنفيذ...) كان يُسقط الاستثناء فيبقى status='pending' دون تغيير، فتلتقط نفس الجدولة مرة أخرى بالدورة
      // التالية لـcron (كل 15 دقيقة) وتُعيد إرسال الرسالة لكل الزبائن من جديد - وتتكرر كل 15 دقيقة للأبد ما لم
      // يُلاحَظ ويُوقَف يدويًا. هذا تسبّب فعليًا باستهلاك باقة SMS كاملة برسائل مكرّرة لنفس الأسماء.
      // الإصلاح: نحجز الجدولة فورًا (قبل إرسال أي رسالة) بقفل تفاؤلي (status=eq.pending بالشرط)، فلا تُعاد
      // معالجتها إطلاقًا مهما فشل لاحقًا أثناء الإرسال الفعلي.
      const claimed = await claimSchedule(schedule, svcHeaders);
      if (!claimed) continue; // عولجت فعلاً باستدعاء آخر بين الفحص والحجز
      await processOneSchedule(schedule, svcHeaders, env);
    } catch (e) {
      console.error('فشلت معالجة جدولة SMS', schedule.id, e);
    }
  }
}

// يحجز الجدولة فورًا قبل إرسال أي رسالة فعليًا، بشرط أنها لا تزال status=pending (قفل تفاؤلي يمنع معالجتها
// مرتين). "مرة واحدة" تُعلَّم completed فورًا؛ "متكررة" يُقدَّم موعدها القادم فورًا - في كلتا الحالتين لا رجوع
// لحالة pending بعدها، فلا يمكن لأي استدعاء لاحق لـcron أن يلتقطها مرة أخرى بغضّ النظر عمّا يحصل أثناء الإرسال
async function claimSchedule(schedule, svcHeaders) {
  const patch = schedule.recurring === 'once' ? { status: 'completed' } : { scheduled_at: nextRecurrence(schedule) };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sms_schedules?id=eq.${schedule.id}&status=eq.pending`, {
    method: 'PATCH', headers: { ...svcHeaders, Prefer: 'return=representation' }, body: JSON.stringify(patch)
  });
  const updated = await res.json();
  return Array.isArray(updated) && updated.length > 0;
}

function nextRecurrence(schedule) {
  const days = schedule.recurring === 'weekly' ? 7 : 30;
  const next = new Date(schedule.scheduled_at);
  next.setDate(next.getDate() + days);
  return next.toISOString();
}

async function processOneSchedule(schedule, svcHeaders, env) {
  const tplRes = await fetch(`${SUPABASE_URL}/rest/v1/sms_templates?id=eq.${schedule.template_id}&select=*`, { headers: svcHeaders });
  const templates = await tplRes.json();
  const template = Array.isArray(templates) ? templates[0] : null;
  if (!template) return; // الجدولة محجوزة فعلاً (claimSchedule) فلا حاجة لتحديث حالتها هنا

  const shopRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${schedule.shop_id}&select=name`, { headers: svcHeaders });
  const shops = await shopRes.json();
  const shopName = (Array.isArray(shops) && shops[0]?.name) || '';

  let custQuery = `shop_id=eq.${schedule.shop_id}&is_deleted=eq.false&sms_excluded=eq.false`;
  if (schedule.target !== 'all') custQuery += `&payment_cycle=eq.${schedule.target}`;
  const custRes = await fetch(`${SUPABASE_URL}/rest/v1/customers?${custQuery}&select=*`, { headers: svcHeaders });
  const customers = await custRes.json();
  const excludedIds = new Set(Array.isArray(schedule.excluded_customer_ids) ? schedule.excluded_customer_ids : []);

  // حاجز حماية أخير (دفاع بعمق) ضد أي إرسال مكرّر فعلي: نتجاهل أي زبون أُرسلت له رسالة بنجاح بهذه الجدولة
  // تحديدًا من قبل - نادر الحدوث بعد claimSchedule أعلاه، لكنه يمنع مضاعفة استهلاك الباقة مهما كان السبب
  const sentRes = await fetch(`${SUPABASE_URL}/rest/v1/sms_log?schedule_id=eq.${schedule.id}&status=eq.sent&select=customer_id`, { headers: svcHeaders });
  const sentRows = await sentRes.json();
  const alreadySentIds = new Set((Array.isArray(sentRows) ? sentRows : []).map(r => r.customer_id));

  for (const customer of (Array.isArray(customers) ? customers : [])) {
    if (excludedIds.has(customer.id) || alreadySentIds.has(customer.id)) continue;
    const balance = await getCustomerBalanceRemote(customer.id, svcHeaders);
    if (balance <= 0) continue; // ما نبعت تذكير لزبون ما عليه دين حاليًا

    const dueDate = await getExpectedDueDateRemote(customer, balance, svcHeaders);
    const message = renderSmsTemplateRemote(template.body, { customerName: customer.name, balanceCents: balance, dueDate, shopName });

    let result;
    if (!customer.phone) {
      result = { success: false, error: 'لا يوجد رقم هاتف لهذا الزبون' };
    } else {
      result = await sendSms(customer.phone, message, env);
    }

    const segments = countSmsSegments(message);
    await fetch(`${SUPABASE_URL}/rest/v1/sms_log`, {
      method: 'POST', headers: svcHeaders,
      body: JSON.stringify({
        shop_id: schedule.shop_id, schedule_id: schedule.id, customer_id: customer.id,
        customer_name: customer.name, phone: customer.phone || '', message, segments,
        scheduled_at: schedule.scheduled_at, sent_at: new Date().toISOString(),
        status: result.success ? 'sent' : 'failed', error: result.error || null
      })
    });

    // نحدّث عدّاد استهلاك الرسائل فقط عند نجاح الإرسال فعليًا (لا نحسب المحاولات الفاشلة)
    if (result.success) {
      await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_shop_sms_segments`, {
        method: 'POST', headers: svcHeaders,
        body: JSON.stringify({ p_shop_id: schedule.shop_id, p_amount: segments })
      });
    }
  }
}

async function getCustomerBalanceRemote(customerId, svcHeaders) {
  const salesRes = await fetch(`${SUPABASE_URL}/rest/v1/sales?customer_id=eq.${customerId}&is_deleted=eq.false&select=paid_debt`, { headers: svcHeaders });
  const sales = await salesRes.json();
  const debtTotal = (Array.isArray(sales) ? sales : []).reduce((s, x) => s + (x.paid_debt || 0), 0);
  const paymentsRes = await fetch(`${SUPABASE_URL}/rest/v1/payments?customer_id=eq.${customerId}&is_deleted=eq.false&select=amount`, { headers: svcHeaders });
  const payments = await paymentsRes.json();
  const paidTotal = (Array.isArray(payments) ? payments : []).reduce((s, x) => s + (x.amount || 0), 0);
  return debtTotal - paidTotal;
}

// موعد السداد المتوقع = آخر فاتورة دين + دورة السداد (نفس منطق getExpectedDueDate بـ database.js)
async function getExpectedDueDateRemote(customer, balance, svcHeaders) {
  const days = CYCLE_DAYS[customer.payment_cycle];
  if (!days || balance <= 0) return null;
  const salesRes = await fetch(
    `${SUPABASE_URL}/rest/v1/sales?customer_id=eq.${customer.id}&is_deleted=eq.false&paid_debt=gt.0&select=created_at&order=created_at.desc&limit=1`,
    { headers: svcHeaders }
  );
  const sales = await salesRes.json();
  if (!Array.isArray(sales) || !sales.length) return null;
  const last = new Date(sales[0].created_at);
  last.setDate(last.getDate() + days);
  return last.toISOString();
}

function formatMoneyPlainRemote(cents) {
  return `${((cents || 0) / 100).toFixed(2)} ₪`;
}
function formatDatePlainRemote(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
// نفس منطق renderSmsTemplate بـ database.js (مكرّر عمدًا - لا وحدات ES مشتركة بين المتصفح والـ Worker)
function renderSmsTemplateRemote(body, { customerName, balanceCents, dueDate, shopName }) {
  return (body || '')
    .split('{name}').join(customerName || '')
    .split('{amount}').join(formatMoneyPlainRemote(balanceCents))
    .split('{due_date}').join(formatDatePlainRemote(dueDate))
    .split('{shop_name}').join(shopName || '');
}

// نفس منطق countSmsSegments بـ database.js: عربي 70 حرف/رسالة، إنجليزي 160 حرف/رسالة (تقريب للأعلى)
function countSmsSegments(text) {
  const len = (text || '').length;
  if (!len) return 0;
  const isArabic = /[؀-ۿݐ-ݿ]/.test(text);
  return Math.ceil(len / (isArabic ? 70 : 160));
}

// ---------- التكامل مع مزوّد TweetSMS (tweetsms.ps) - واجهة JSON الرسمية ----------
// المفتاح والمرسل يُقرآن من أسرار Cloudflare (SMS_PROVIDER_API_KEY / SMS_PROVIDER_SENDER) - لا يوجدان بالكود أبدًا
// أكواد الرد موثّقة رسميًا من TweetSMS (Postman collection) - راجع TWEETSMS_ERROR_CODES بالأسفل
const TWEETSMS_ERROR_CODES = {
  '-100': 'معاملات ناقصة بالطلب',
  '-110': 'اسم المستخدم أو كلمة المرور خاطئة',
  '-111': 'الحساب غير مفعّل',
  '-112': 'الحساب محظور',
  '-114': 'خدمة الإرسال متوقفة لهذا الحساب',
  '-115': 'اسم المرسل (Sender) غير صالح',
  '-116': 'اسم المرسل (Sender) غير صالح',
  '-120': 'لا يوجد أرقام صالحة بالطلب',
  '-124': 'لا يوجد رصيد كافٍ بحساب TweetSMS لإرسال هذه الرسالة',
  '-126': 'تعذّر الإرسال الآن (قد تكون تُرسل من مصدر آخر بنفس الوقت)'
};

async function sendSms(phone, message, env) {
  const apiKey = env.SMS_PROVIDER_API_KEY;
  if (!apiKey) return { success: false, error: 'السرّ SMS_PROVIDER_API_KEY غير مضبوط على Cloudflare Workers' };
  const sender = env.SMS_PROVIDER_SENDER;
  if (!sender) return { success: false, error: 'السرّ SMS_PROVIDER_SENDER غير مضبوط على Cloudflare Workers' };

  const normalizedPhone = normalizePalestinianPhone(phone);
  if (!normalizedPhone) return { success: false, error: `رقم هاتف غير صالح: ${phone}` };

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const body = {
    api_key: apiKey,
    sender,
    message,
    to: normalizedPhone,
    groups: '',
    date: `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`
  };

  try {
    const res = await fetch('https://www.tweetsms.ps/api.php/office/sendsms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = (await res.text()).trim();

    let code = null;
    try {
      const parsed = JSON.parse(text);
      code = typeof parsed === 'number' || typeof parsed === 'string' ? parsed : (parsed?.code ?? parsed?.status ?? null);
    } catch (e) {
      const match = text.match(/-?\d+/);
      code = match ? match[0] : null;
    }
    code = String(code);

    if (code === '999') return { success: true };
    return { success: false, error: TWEETSMS_ERROR_CODES[code] || `رد غير متوقع من المزوّد: ${text.slice(0, 200)}` };
  } catch (e) {
    return { success: false, error: `تعذّر الاتصال بمزوّد SMS: ${e.message}` };
  }
}

// يحوّل رقم الزبون المحلي (05xxxxxxxx أو +9705xxxxxxxx) إلى صيغة 9725xxxxxxxx التي يتوقعها TweetSMS
function normalizePalestinianPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('972') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `972${digits.slice(1)}`;
  if (digits.length === 9) return `972${digits}`; // بدون صفر بادئة
  return null;
}

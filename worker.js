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
    if (url.pathname === '/api/bot/telegram-webhook') {
      return handleTelegramWebhook(request, env);
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
  const allCustomers = await custRes.json();
  const excludedIds = new Set(Array.isArray(schedule.excluded_customer_ids) ? schedule.excluded_customer_ids : []);

  // حاجز حماية أخير (دفاع بعمق) ضد أي إرسال مكرّر فعلي: نتجاهل أي زبون أُرسلت له رسالة بنجاح بهذه الجدولة
  // تحديدًا من قبل - نادر الحدوث بعد claimSchedule أعلاه، لكنه يمنع مضاعفة استهلاك الباقة مهما كان السبب
  const sentRes = await fetch(`${SUPABASE_URL}/rest/v1/sms_log?schedule_id=eq.${schedule.id}&status=eq.sent&select=customer_id`, { headers: svcHeaders });
  const sentRows = await sentRes.json();
  const alreadySentIds = new Set((Array.isArray(sentRows) ? sentRows : []).map(r => r.customer_id));

  const customers = (Array.isArray(allCustomers) ? allCustomers : [])
    .filter(c => !excludedIds.has(c.id) && !alreadySentIds.has(c.id));
  if (!customers.length) return;

  // إصلاح أداء/موثوقية مهم: كان يُحسب رصيد كل زبون وموعد استحقاقه باستعلامين منفصلين لكل زبون على حدة
  // (حتى 4 طلبات شبكة إضافية × عدد الزبائن المستهدفين). بحسابات Cloudflare المجانية (حد 50 طلبًا بالتنفيذ
  // الواحد) كانت جدولة لـ15 زبونًا فقط تحتاج ~70 طلبًا فتفشل حتميًا بالمنتصف - والآن بعد claimSchedule لا
  // تُعاد محاولتها فتُرسَل لجزء من الزبائن فقط بصمت دون أي تنبيه. نجلب كل البيانات اللازمة لكل الزبائن
  // باستعلامين اثنين فقط إجمالًا (بغض النظر عن عددهم)، ونُدرج سجلات الإرسال دفعة واحدة بالنهاية كذلك
  const { balances, dueDates } = await fetchBalancesAndDueDates(customers, svcHeaders, schedule.shop_id);

  const logEntries = [];
  let totalSegments = 0;

  for (const customer of customers) {
    const balance = balances.get(customer.id) || 0;
    if (balance <= 0) continue; // ما نبعت تذكير لزبون ما عليه دين حاليًا

    const dueDate = dueDates.get(customer.id) || null;
    const message = renderSmsTemplateRemote(template.body, { customerName: customer.name, balanceCents: balance, dueDate, shopName });

    let result;
    if (!customer.phone) {
      result = { success: false, error: 'لا يوجد رقم هاتف لهذا الزبون' };
    } else {
      result = await sendSms(customer.phone, message, env);
    }

    const segments = countSmsSegments(message);
    if (result.success) totalSegments += segments;
    logEntries.push({
      shop_id: schedule.shop_id, schedule_id: schedule.id, customer_id: customer.id,
      customer_name: customer.name, phone: customer.phone || '', message, segments,
      scheduled_at: schedule.scheduled_at, sent_at: new Date().toISOString(),
      status: result.success ? 'sent' : 'failed', error: result.error || null
    });
  }

  if (!logEntries.length) return;

  // إدراج دفعة واحدة لكل سجلات الإرسال (PostgREST يقبل مصفوفة بطلب POST واحد) بدل طلب منفصل لكل زبون
  await fetch(`${SUPABASE_URL}/rest/v1/sms_log`, { method: 'POST', headers: svcHeaders, body: JSON.stringify(logEntries) });

  // نحدّث عدّاد استهلاك الرسائل مرة واحدة بإجمالي كل الرسائل الناجحة فعليًا (لا نحسب المحاولات الفاشلة)
  if (totalSegments > 0) {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_shop_sms_segments`, {
      method: 'POST', headers: svcHeaders, body: JSON.stringify({ p_shop_id: schedule.shop_id, p_amount: totalSegments })
    });
  }
}

// يحسب رصيد الدين وموعد الاستحقاق المتوقع لكل زبائن الدفعة دفعة واحدة باستعلامين فقط إجمالًا (نفس منطق
// getCustomerBalance/getExpectedDueDate بـdatabase.js لكن مجمَّع لكل الزبائن معًا بدل استعلام منفصل لكل واحد)
// shopId: تصفية إضافية (دفاع بعمق) جنب customer_id=in.(...) - الأخيرة وحدها آمنة فعليًا (customer_id مفتاح
// أساسي uuid فريد عالميًا، لا يتكرر بين محلين أبدًا)، لكن شرط shop_id الصريح يجعل هذا الضمان مكتوبًا بالكود
// نفسه بدل الاعتماد على استنتاج ضمني حول تفرّد المعرّفات، تماشيًا مع قاعدة "كل استعلام مفلتر بـshop_id"
export async function fetchBalancesAndDueDates(customers, svcHeaders, shopId) {
  const idsParam = encodeURIComponent(`in.(${customers.map(c => c.id).join(',')})`);
  const shopFilter = shopId ? `&shop_id=eq.${shopId}` : '';
  const [salesRes, paymentsRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/sales?customer_id=${idsParam}${shopFilter}&is_deleted=eq.false&select=customer_id,paid_debt,created_at`, { headers: svcHeaders }),
    // discount يُخفَّض من الدين تمامًا كالمبلغ المحصَّل (راجع getCustomerBalance بـdatabase.js) - بدونه هنا
    // كانت أرصدة تذكيرات SMS تظهر أعلى من الواقع لأي زبون استُخدم له خصم عند تسجيل دفعة
    fetch(`${SUPABASE_URL}/rest/v1/payments?customer_id=${idsParam}${shopFilter}&is_deleted=eq.false&select=customer_id,amount,discount`, { headers: svcHeaders })
  ]);
  const sales = await salesRes.json();
  const payments = await paymentsRes.json();

  const debtTotals = new Map(), paidTotals = new Map(), lastDebtSaleDate = new Map();
  for (const s of (Array.isArray(sales) ? sales : [])) {
    debtTotals.set(s.customer_id, (debtTotals.get(s.customer_id) || 0) + (s.paid_debt || 0));
    if (s.paid_debt > 0) {
      const prev = lastDebtSaleDate.get(s.customer_id);
      if (!prev || s.created_at > prev) lastDebtSaleDate.set(s.customer_id, s.created_at);
    }
  }
  for (const p of (Array.isArray(payments) ? payments : [])) {
    paidTotals.set(p.customer_id, (paidTotals.get(p.customer_id) || 0) + (p.amount || 0) + (p.discount || 0));
  }

  const balances = new Map();
  const dueDates = new Map();
  for (const c of customers) {
    const balance = (debtTotals.get(c.id) || 0) - (paidTotals.get(c.id) || 0);
    balances.set(c.id, balance);
    const days = CYCLE_DAYS[c.payment_cycle];
    const lastSale = lastDebtSaleDate.get(c.id);
    if (days && balance > 0 && lastSale) {
      const d = new Date(lastSale);
      d.setDate(d.getDate() + days);
      dueDates.set(c.id, d.toISOString());
    }
  }
  return { balances, dueDates };
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

// ============================================================
// بوت تيليجرام (المرحلة 1: استعلامات فقط) - تيليجرام → هذا الـWorker → Workers AI (تصنيف نية فقط) → سوبابيس → رد
// الأسرار المطلوبة (Cloudflare Secrets): TELEGRAM_BOT_TOKEN، TELEGRAM_WEBHOOK_SECRET فقط
// (SUPABASE_SERVICE_ROLE_KEY مستخدَم أصلًا بباقي الملف. Workers AI مربوط عبر [ai] بـwrangler.toml - لا مفتاح
// API منفصل له إطلاقًا، جزء من حساب Cloudflare نفسه). shop_id يُقرأ دائمًا من جدول bot_users (بعد مطابقة
// chat_id)، لا من نص الرسالة ولا من مخرجات الذكاء الاصطناعي إطلاقًا - يُستخدَم فقط لتصنيف النية واستخراج
// فلاتر نصية (اسم/ملاحظة/تاريخ)، والاستعلامات الفعلية كلها مكتوبة هنا جاهزة (PostgREST عبر REST، لا SQL خام أبدًا)
// ============================================================

const BOT_INTENTS = new Set(['customer_balance', 'customer_invoices', 'customer_statement', 'today_sales', 'top_debtors', 'unknown']);

export async function handleTelegramWebhook(request, env) {
  if (request.method !== 'POST') return json({ ok: true }); // تيليجرام لا يحتاج ردًا مفيدًا لغير POST

  // تحقّق أمني: الطلب فعلاً من تيليجرام (لا من أي طرف يعرف المسار فقط) - راجع تعليمات ضبط secret_token بالنشر
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== secret) {
    return json({ ok: false }, 401);
  }

  const botToken = env.TELEGRAM_BOT_TOKEN;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!botToken || !serviceKey) { console.error('TELEGRAM_BOT_TOKEN أو SUPABASE_SERVICE_ROLE_KEY غير مضبوطَين'); return json({ ok: true }); }
  const svcHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  let update;
  try { update = await request.json(); } catch (e) { return json({ ok: true }); }

  // نرد دائمًا بـ200 لتيليجرام بغض النظر عن نتيجة المعالجة الداخلية - أي خطأ هنا نُسجّله فقط، ولا نجعل
  // تيليجرام يعيد إرسال نفس التحديث مرارًا (سلوكه الافتراضي عند أي استجابة غير 200)
  try {
    const message = update?.message;
    const chatId = message?.chat?.id;
    const text = (message?.text || '').trim();
    if (!chatId || !text) return json({ ok: true });

    const startMatch = text.match(/^\/start(?:\s+(\S+))?/);
    if (startMatch) {
      await handleBotStart(chatId, startMatch[1] || '', message.from, svcHeaders, botToken, env);
      return json({ ok: true });
    }

    const botUser = await getBotUser(chatId, svcHeaders);
    if (!botUser) {
      await sendTelegramMessage(chatId, 'حسابك غير مرتبط بأي محل بعد. اطلب رابط الربط من صاحب المحل (الإعدادات > ربط تيليجرام)، أو افتحه بنفسك إن كنت صاحب المحل.', botToken, env);
      return json({ ok: true });
    }

    await handleBotMessage(chatId, text, botUser, svcHeaders, botToken, env);
  } catch (e) {
    console.error('خطأ أثناء معالجة تحديث بوت تيليجرام', e);
  }
  return json({ ok: true });
}

async function sendTelegramMessage(chatId, text, botToken, env) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!res.ok) console.error('فشل إرسال رد تيليجرام', await res.text());
  } catch (e) {
    console.error('تعذّر الاتصال بـAPI تيليجرام', e);
  }
}

// مؤشر "يكتب..." الأصلي بتيليجرام - يظهر ~5 ثوانٍ تلقائيًا بالمحادثة، تحسين تجربة أثناء معالجة قد تأخذ
// ثوانٍ معدودة (تصنيف النية + احتمال إعادة محاولات 503). تُستدعى دون انتظار (fire-and-forget) عمدًا
async function sendChatAction(chatId, botToken, env) {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    });
  } catch (e) {
    // غير حرج إطلاقًا - مجرد مؤشر واجهة، تجاهل أي فشل بصمت
  }
}

async function getBotUser(chatId, svcHeaders) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/bot_users?chat_id=eq.${chatId}&select=*`, { headers: svcHeaders });
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// ---------- /start <code>: ربط chat_id بمحل عبر كود لمرة واحدة ----------
async function handleBotStart(chatId, code, fromUser, svcHeaders, botToken, env) {
  if (!code) {
    await sendTelegramMessage(chatId, 'افتح رابط الربط من إعدادات التطبيق (ربط تيليجرام) حتى يتم ربط حسابك تلقائيًا.', botToken, env);
    return;
  }

  const codeRes = await fetch(`${SUPABASE_URL}/rest/v1/bot_link_codes?code=eq.${encodeURIComponent(code)}&select=*`, { headers: svcHeaders });
  const codeRows = await codeRes.json();
  const linkCode = Array.isArray(codeRows) && codeRows.length ? codeRows[0] : null;

  if (!linkCode || new Date(linkCode.expires_at) < new Date()) {
    await sendTelegramMessage(chatId, '⚠️ رابط الربط غير صالح أو منتهي الصلاحية (صالح 10 دقائق فقط). اطلب رابطًا جديدًا من إعدادات التطبيق.', botToken, env);
    if (linkCode) await fetch(`${SUPABASE_URL}/rest/v1/bot_link_codes?code=eq.${encodeURIComponent(code)}`, { method: 'DELETE', headers: svcHeaders });
    return;
  }

  const name = [fromUser?.first_name, fromUser?.last_name].filter(Boolean).join(' ') || fromUser?.username || 'مستخدم تيليجرام';

  // upsert بالاعتماد على فرادة chat_id (unique) - لو كان هذا الـchat_id مربوطًا بمحل آخر من قبل، الربط الجديد يستبدله
  await fetch(`${SUPABASE_URL}/rest/v1/bot_users?on_conflict=chat_id`, {
    method: 'POST', headers: { ...svcHeaders, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ chat_id: chatId, shop_id: linkCode.shop_id, name, role: linkCode.role })
  });
  // الكود لمرة واحدة فقط - يُحذف فورًا بعد الاستخدام بغض النظر عن النجاح، فلا يمكن إعادة استخدامه
  await fetch(`${SUPABASE_URL}/rest/v1/bot_link_codes?code=eq.${encodeURIComponent(code)}`, { method: 'DELETE', headers: svcHeaders });

  const shopRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${linkCode.shop_id}&select=name`, { headers: svcHeaders });
  const shops = await shopRes.json();
  const shopName = (Array.isArray(shops) && shops[0]?.name) || 'محلك';

  await sendTelegramMessage(chatId, `✅ تم الربط بنجاح بمحل "${shopName}" بصفة ${linkCode.role === 'owner' ? 'مالك' : 'موظف'}.\n\nجرّب الآن مثلاً: "رصيد فلان" أو "مبيعات اليوم".`, botToken, env);
}

// ---------- معالجة رسالة عادية من حساب مرتبط: Workers AI لتصنيف النية فقط، ثم استعلام جاهز مسبقًا ----------
async function handleBotMessage(chatId, text, botUser, svcHeaders, botToken, env) {
  const shopId = botUser.shop_id; // shop_id دائمًا من bot_users - لا من parsed إطلاقًا (الذكاء الاصطناعي لا يُرجع shop_id أصلًا)

  // استئناف اختيار رقمي من قائمة غموض سابقة (صالحة دقيقتين فقط) - بدون أي استدعاء للذكاء الاصطناعي إطلاقًا:
  // أسرع وأرخص وأدق، ويتجنّب تمامًا خطأ ملاحَظًا فعليًا (رد المستخدم برقم مجرَّد بلا سياق كان يُرسَل للنموذج
  // كرسالة مستقلة فيحاول "يفهمه" وأحيانًا يُخرِج نص تعليمات البرومبت نفسه كاسم زبون!)
  const numMatch = text.trim().match(/^(\d{1,2})$/);
  if (numMatch && botUser.pending_matches && botUser.pending_expires_at && new Date(botUser.pending_expires_at) > new Date()) {
    const idx = parseInt(numMatch[1], 10) - 1;
    const matches = botUser.pending_matches;
    const pendingIntent = botUser.pending_intent;
    const pendingParams = botUser.pending_params;
    await clearPendingState(chatId, svcHeaders);
    if (idx < 0 || idx >= matches.length) {
      await sendTelegramMessage(chatId, `رقم غير صحيح. اختر رقمًا من 1 إلى ${matches.length}، أو ابعت اسم الزبون من جديد.`, botToken, env);
      return;
    }
    sendChatAction(chatId, botToken, env);
    const reply = await resolveIntentForCustomer(shopId, pendingIntent, pendingParams, matches[idx], svcHeaders);
    await sendTelegramMessage(chatId, typeof reply === 'string' ? reply : 'حدث خطأ غير متوقَّع.', botToken, env);
    return;
  }

  if (!env.AI) {
    await sendTelegramMessage(chatId, 'البوت غير مهيأ بعد (ربط Workers AI ناقص - راجع [ai] بـwrangler.toml).', botToken, env);
    return;
  }

  // مؤشر "يكتب..." الأصلي بتيليجرام (لا رسالة نصية إضافية تُزاحم المحادثة) - يُطمئن المستخدم أن البوت يعالج
  // طلبه فعليًا، خصوصًا أثناء إعادة المحاولات المحتملة بـclassifyIntent (قد تصل لثوانٍ معدودة)
  sendChatAction(chatId, botToken, env); // لا ننتظرها (fire-and-forget) - لا تؤخّر المعالجة الفعلية بأي شيء

  let parsed;
  try {
    parsed = await classifyIntent(text, env.AI);
  } catch (e) {
    // نسجّل e.message صراحة (console.error('نص', e) وحدها لا يُظهر رسالة الخطأ الفعلية بسجلّات Cloudflare،
    // فقط نص الـstack trace) - ونُظهر مختصرها بالرد نفسه مؤقتًا لتسريع التشخيص أثناء الإعداد الأول
    console.error('فشل تصنيف النية عبر Workers AI:', e.message, e.stack);
    await sendTelegramMessage(chatId, `تعذّر فهم طلبك حاليًا.\n(تفاصيل للمطوّر: ${String(e.message || e).slice(0, 200)})`, botToken, env);
    return;
  }

  // حاجز أمان/جودة: لو "استخرج" النموذج (نادر لكن حصل فعليًا) نص تعليمات البرومبت نفسه بدل اسم حقيقي، أو كلمة
  // تاريخ نسبي علقت بآخر الاسم ("خال مبارح" بدل "خال" + تاريخ أمس) - ننظّف قبل أي استخدام للقيمة كفلتر بحث
  parsed.customer = sanitizeExtractedCustomer(parsed.customer);

  // تصحيح حتمي بكود لا بالذكاء الاصطناعي لتاريخ "يوم من الشهر" (راجع تعليق extractDayOfMonthDate) - يتجاوز
  // from/to مهما كانت قيمتهما لو النمط موجود صراحة بالرسالة، لأن النموذج لوحظ يتجاهل هذا التركيب أحيانًا
  if (parsed.intent === 'customer_invoices') {
    const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Gaza' }).format(new Date());
    const [curYear, curMonth] = todayStr.split('-');
    const explicitDayDate = extractDayOfMonthDate(text, curYear, curMonth);
    if (explicitDayDate) { parsed.from = explicitDayDate; parsed.to = explicitDayDate; }
  }

  let reply;
  switch (parsed.intent) {
    case 'customer_balance':
      reply = await handleIntentCustomerBalance(shopId, parsed.customer, svcHeaders);
      break;
    case 'customer_invoices':
      reply = await handleIntentCustomerInvoices(shopId, parsed, svcHeaders);
      break;
    case 'customer_statement':
      reply = await handleIntentCustomerStatement(shopId, parsed.customer, svcHeaders);
      break;
    case 'today_sales':
      reply = await handleIntentTodaySales(shopId, svcHeaders);
      break;
    case 'top_debtors':
      reply = await handleIntentTopDebtors(shopId, svcHeaders);
      break;
    default:
      reply = 'ما قدرت أفهم طلبك. جرّب مثلاً: "رصيد أبو خالد" أو "مبيعات اليوم" أو "أكثر الزبائن ديون".';
  }

  // غموض بالاسم: نحفظ القائمة المعروضة والنية الأصلية لدقيقتين، حتى يقدر المستخدم يرد برقم بسيط بدل الاسم كامل
  if (reply && typeof reply === 'object' && reply.__ambiguous) {
    await savePendingState(chatId, parsed.intent, parsed, reply.matches, svcHeaders);
    await sendTelegramMessage(chatId, formatAmbiguousReply(reply.matches), botToken, env);
    return;
  }
  await sendTelegramMessage(chatId, reply, botToken, env);
}

// تُستخدم فقط بالمسارين اللذين يحتاجان اسم زبون (رصيد/فواتير) - today_sales وtop_debtors لا يصلان هنا إطلاقًا
async function resolveIntentForCustomer(shopId, intent, params, customer, svcHeaders) {
  if (intent === 'customer_balance') return replyCustomerBalance(customer, shopId, svcHeaders);
  if (intent === 'customer_invoices') return replyCustomerInvoices(customer, params || {}, shopId, svcHeaders);
  if (intent === 'customer_statement') return replyCustomerStatement(customer, shopId, svcHeaders);
  return 'حدث خطأ غير متوقَّع، جرّب من جديد.';
}

async function savePendingState(chatId, intent, params, matches, svcHeaders) {
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // صالحة دقيقتين فقط
  await fetch(`${SUPABASE_URL}/rest/v1/bot_users?chat_id=eq.${chatId}`, {
    method: 'PATCH', headers: svcHeaders,
    body: JSON.stringify({
      pending_intent: intent,
      pending_params: params,
      pending_matches: matches.slice(0, 8).map(m => ({ id: m.id, name: m.name, phone: m.phone })),
      pending_expires_at: expiresAt
    })
  });
}

async function clearPendingState(chatId, svcHeaders) {
  await fetch(`${SUPABASE_URL}/rest/v1/bot_users?chat_id=eq.${chatId}`, {
    method: 'PATCH', headers: svcHeaders,
    body: JSON.stringify({ pending_intent: null, pending_params: null, pending_matches: null, pending_expires_at: null })
  });
}

const RELATIVE_DATE_WORDS = new Set(['مبارح', 'امبارح', 'إمبارح', 'اليوم', 'أمس']);
function sanitizeExtractedCustomer(customer) {
  if (!customer) return null;
  // لو النموذج أعاد نص تعليمات البرومبت نفسه بالخطأ بدل اسم حقيقي - نتجاهله تمامًا
  if (/اسم الزبون|أو null|customer_balance|customer_invoices|today_sales|top_debtors/i.test(customer)) return null;
  // كلمات تاريخ نسبي علقت بالاسم المستخرَج ("خال مبارح") - نشيلها، التاريخ نفسه مستخرَج أصلًا بحقلي from/to
  const cleaned = customer.split(/\s+/).filter(w => !RELATIVE_DATE_WORDS.has(w)).join(' ').trim();
  return cleaned || null;
}

// استخراج تاريخ "يوم من الشهر" (مثل "22 الشهر هاد" أو "22 شهر 10") مباشرة من نص الرسالة بكود حتمي، لا عبر
// الذكاء الاصطناعي - نموذج بحجم 3B لوحظ فعليًا أنه غير موثوق بتركيب تاريخ من رقم يوم + شهر حالي/صريح (كان
// يتجاهل المثال المعطى بالبرومبت ويرجع تاريخ اليوم الحالي بدل اليوم المطلوب). يُستخدَم كتصحيح لاحق يتجاوز
// ناتج الذكاء الاصطناعي لحقلي from/to لو انطبق أحد هذين النمطين بالضبط
function extractDayOfMonthDate(text, curYear, curMonth) {
  // "22 شهر 10" / "في 22 شهر 10" - رقم يوم + كلمة شهر + رقم شهر صريح
  let m = text.match(/(\d{1,2})\s*(?:في\s*)?شهر\s*(\d{1,2})\b/);
  if (m) return `${curYear}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;

  // "22 الشهر هاد" / "هاد الشهر 22" / "22 هذا الشهر" - رقم يوم + إشارة للشهر الحالي، بلا رقم شهر صريح
  if (/(هاد|هذا)\s*الشهر|الشهر\s*(هاد|هذا)/.test(text)) {
    const dayMatch = text.match(/\b(\d{1,2})\b/);
    if (dayMatch) return `${curYear}-${curMonth}-${dayMatch[1].padStart(2, '0')}`;
  }
  return null;
}

// Gemini يُرجع JSON فقط (intent + فلاتر نصية) - ممنوع منعًا باتًا أن يُستخدم ناتجه كـSQL أو كجزء من استعلام خام؛
// كل قيمة يُرجعها تُمرَّر فقط كـvalue لفلتر REST محدَّد مسبقًا بالكود (شرح كامل أعلاه بترويسة القسم)
// Workers AI (نفس منصة الاستضافة، حصة مجانية يومية مضمَّنة بـCloudflare Free بلا أي مفتاح API منفصل) بدل
// Gemini الخارجي - تبديل اضطراري بعد نفاد حصة Gemini المجانية فعليًا بأول استخدام حي (موديل جديد جدًا هناك)
async function classifyIntent(text, ai) {
  // نمرّر تاريخ اليوم وأمس الفعليَّين (بتوقيت فلسطين) جاهزَين بالنص - نماذج صغيرة متل هذا لا يُعتمَد عليها
  // بحساب التواريخ النسبية ("اليوم"، "مبارح") من "معرفتها العامة"، فنحسبها نحن بالكود ونعطيها جاهزة لتستخدمها فقط
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Gaza' }).format(new Date());
  const yesterdayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Gaza' }).format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const [curYear, curMonth] = todayStr.split('-');

  const systemPrompt = `أنت مصنّف نية فقط لرسائل عربية عامية (لهجة فلسطينية) موجّهة لبوت محاسبة محل تجاري. حوّل رسالة المستخدم إلى كائن JSON واحد فقط بهذا الشكل بالضبط، بدون أي نص آخر ولا شرح ولا علامات ترميز:
{"intent": "customer_balance" | "customer_invoices" | "customer_statement" | "today_sales" | "top_debtors" | "unknown", "customer": "اسم الزبون المذكور أو null", "note_contains": "كلمة من الملاحظات إن ذُكرت أو null", "from": "تاريخ البداية YYYY-MM-DD أو null", "to": "تاريخ النهاية YYYY-MM-DD أو null"}

تعريف كل نية:
- customer_balance: سؤال عن رصيد/دين زبون معيّن فقط (مثل "رصيد أبو خالد" أو "هاتلي رصيد أبو خالد" أو "اعطيني رصيد فلان" أو "كم على فلان" أو "هل يوجد ديون لفلان").
- customer_invoices: سؤال عن فواتير/مشتريات/عمليات/ما اشتراه أو أخذه زبون معيّن لفترة أو تاريخ معيّن أو بملاحظة معيّنة (مثل "فواتير سامر" أو "إيش أخذ إبراهيم مبارح" أو "شو اشترى أحمد اليوم" أو "فواتير أحمد اللي فيها للدار").
- customer_statement: طلب "كشف حساب" كامل لزبون معيّن (يشمل رصيده وكل فواتيره معًا) - أي رسالة فيها كلمة "كشف حساب" أو "كشف الحساب" (مثل "كشف حساب أبو خالد" أو "طيب كشف حساب سامر"). from/to دائمًا null لهذه النية - كشف الحساب دائمًا كامل بدون فلترة تاريخ.
- today_sales: سؤال عن مبيعات اليوم إجمالًا (بدون ذكر زبون).
- top_debtors: سؤال عن أكثر الزبائن ديونًا.
- unknown: أي شيء آخر غير هذه الأنواع.

مهم جدًا: from/to تبقى null إلا لو ذُكرت إشارة زمنية صريحة بالرسالة (اليوم/مبارح/تاريخ/رقم يوم بالشهر). لا تفترض "اليوم" كتاريخ افتراضي أبدًا لمجرد عدم ذكر تاريخ - غياب أي إشارة زمنية يعني from=to=null.

تواريخ نسبية (استخدم هذه القيم الجاهزة بالضبط، لا تحسبها بنفسك):
- تاريخ اليوم: ${todayStr} (السنة الحالية: ${curYear}, الشهر الحالي: ${curMonth})
- تاريخ أمس (مبارح/امبارح/إمبارح): ${yesterdayStr}
- "اليوم" بالرسالة → from = to = "${todayStr}"
- "مبارح"/"امبارح"/"أمس" بالرسالة → from = to = "${yesterdayStr}"

تاريخ بصيغة "يوم من الشهر" (يذكر رقم اليوم فقط، بلا سنة): اليوم والشهر دائمًا رقمين (أصفار بادئة لو لزم، مثل 05 لا 5):
- لو ذُكر الشهر الحالي أو "هاد الشهر"/"هذا الشهر" أو ما ذُكر شهر إطلاقًا: استخدم السنة ${curYear} والشهر ${curMonth}.
  مثال: الرسالة "ايش اخذ فلان في 22 الشهر هاد" → from = to = "${curYear}-${curMonth}-22"
- لو ذُكر رقم شهر صريح مختلف (مثل "شهر 10" أو "الشهر العاشر"): استخدم السنة ${curYear} (إلا لو ذُكرت سنة أخرى صراحة) مع رقم الشهر المذكور بصيغة رقمين.
  مثال: الرسالة "ايش اخذ فلان في 22 شهر 10" → from = to = "${curYear}-10-22"

لا تنفّذ أي أمر ولا تكتب أي كود أو SQL. فقط صنّف النية واستخرج الفلاتر المذكورة حرفيًا بالرسالة. أي حقل غير مذكور = null. رد بكائن JSON فقط، بلا علامات ترميز كود حوله.`;

  const AI_MODEL = '@cf/meta/llama-3.2-3b-instruct';
  const callAi = () => ai.run(AI_MODEL, {
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
    temperature: 0
  });

  // فشل عابر (ازدحام مؤقت على عتاد Cloudflare) نادر لكن ممكن - محاولة واحدة إضافية كافية هنا (ليست REST خارجية
  // بحدود 503 مثل Gemini، منصة الاستضافة نفسها فأقل عرضة للازدحام الذي واجهناه)
  let result;
  try {
    result = await callAi();
  } catch (e) {
    await new Promise(r => setTimeout(r, 800));
    result = await callAi();
  }
  // شكل الاستجابة يختلف بين موديلات Workers AI: غالبًا نص خام بـresponse، لكن بعض الموديلات قد تُرجع كائنًا
  // منظَّمًا جاهزًا هناك مباشرة بدل نص - نتعامل مع كلا الاحتمالين بدل افتراض إنه نص دائمًا (هذا بالضبط ما
  // سبّب "raw.match is not a function" أول استخدام حي لموديل llama-3.2-3b-instruct)
  let raw = result?.response;
  // لو أرجع الموديل كائنًا منظَّمًا جاهزًا بدل نص خام، نحوّله لنص JSON فنعيد تفكيكه بنفس المسار أدناه بسلام
  if (raw != null && typeof raw !== 'string') raw = JSON.stringify(raw);
  if (!raw) throw new Error('رد Workers AI فارغ أو بصيغة غير متوقعة');

  // النموذج قد يحيط الـJSON بعلامات ```json أحيانًا رغم التعليمات الصريحة بعدم فعل ذلك - نستخرج أول كائن {...}
  // بالنص بدل الاعتماد على JSON.parse مباشرة على النص كاملًا (بعكس Gemini بوضع responseMimeType الصارم سابقًا)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  let obj;
  try { obj = JSON.parse(jsonMatch ? jsonMatch[0] : raw); } catch (e) { throw new Error('رد Workers AI ليس JSON صالحًا: ' + raw.slice(0, 200)); }

  // تحقّق صارم: أي قيمة خارج القائمة البيضاء تُعامَل كـ"unknown" - لا نثق بأي نص حر يُرجعه النموذج كنية تنفيذية
  const intent = BOT_INTENTS.has(obj?.intent) ? obj.intent : 'unknown';
  return {
    intent,
    customer: typeof obj?.customer === 'string' ? obj.customer.trim() : null,
    note_contains: typeof obj?.note_contains === 'string' ? obj.note_contains.trim() : null,
    from: typeof obj?.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.from) ? obj.from : null,
    to: typeof obj?.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.to) ? obj.to : null
  };
}

// تطبيع عربي مبسَّط (نفس قواعد normalizeArabic بـjs/utils.js) لمطابقة أسماء الزبائن - مكرَّر هنا عمدًا (لا
// يُستورَد من js/utils.js) لإبقاء هذا الملف مستقلًا تمامًا عن كود المتصفح، بنفس أسلوب formatMoneyPlainRemote وغيرها
export function normalizeArabicRemote(str) {
  if (!str) return '';
  return String(str).toLowerCase()
    .replace(/[إأآا]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[ًٌٍَُِّْ]/g, '').trim();
}

// حدود "اليوم المحلي" بتوقيت فلسطين (Asia/Gaza) كاملة بالـUTC - منتصف ليل غزة لا منتصف ليل UTC، ومراعية
// للتوقيت الصيفي تلقائيًا (نحسب الإزاحة الفعلية لنفس التاريخ المطلوب لا إزاحة ثابتة). بدونها كانت حدود
// "اليوم"/التواريخ المطلوبة (مبارح، اليوم...) تنزاح بضع ساعات عن اليوم الفعلي بتوقيت غزة
export function gazaDayBoundsUtc(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const approxUtcMidnight = new Date(Date.UTC(y, m - 1, d));
  const offsetParts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Gaza', timeZoneName: 'shortOffset' }).formatToParts(approxUtcMidnight);
  const offsetStr = offsetParts.find(p => p.type === 'timeZoneName')?.value || 'GMT+0';
  const match = offsetStr.match(/GMT([+-]\d+)(?::(\d+))?/);
  const offsetMin = match ? (parseInt(match[1], 10) * 60 + (match[1].startsWith('-') ? -1 : 1) * (match[2] ? parseInt(match[2], 10) : 0)) : 0;
  const startUtc = new Date(approxUtcMidnight.getTime() - offsetMin * 60 * 1000);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start: startUtc.toISOString(), end: endUtc.toISOString() };
}

// مطابقة بسيطة بالاحتواء (لا ترتيب/تقييم متقدّم - اكتفاءً بالمطلوب فعليًا بالمرحلة 1): نجلب كل زبائن المحل
// (مفلترين بـshop_id فقط) ونطابق بالتطبيع + substring على الجهتين، حتى يعمل البحث الجزئي ("خالد" يطابق "أبو خالد")
export async function findCustomerByName(shopId, query, svcHeaders) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/customers?shop_id=eq.${shopId}&is_deleted=eq.false&select=id,name,phone`, { headers: svcHeaders });
  const customers = await res.json();
  if (!Array.isArray(customers)) return { status: 'none' };

  const normQuery = normalizeArabicRemote(query);
  if (!normQuery) return { status: 'none' };

  const matches = customers.filter(c => {
    const normName = normalizeArabicRemote(c.name);
    return normName.includes(normQuery) || normQuery.includes(normName);
  });

  if (!matches.length) return { status: 'none' };
  if (matches.length === 1) return { status: 'found', customer: matches[0] };
  return { status: 'ambiguous', matches };
}

function formatAmbiguousReply(matches) {
  const list = matches.slice(0, 8).map((c, i) => `${i + 1}. ${c.name}${c.phone ? ` (${c.phone})` : ''}`).join('\n');
  return `في أكثر من زبون بهالاسم:\n${list}\n\nابعت رقم الزبون المطلوب (مثلاً 1)، أو اسمه كامل/أدق لو حابب.`;
}

// ---------- النية 1: رصيد زبون ----------
// تُرجع نص الرد مباشرة، أو marker خاص {__ambiguous:true, matches} ليتولّى handleBotMessage حفظ حالة
// "بانتظار اختيار رقمي" قبل الرد (راجع savePendingState) - بدل تنسيق رد الغموض هنا مباشرة كما كان سابقًا
async function handleIntentCustomerBalance(shopId, customerQuery, svcHeaders) {
  if (!customerQuery) return 'بدي اسم الزبون حتى أقدر أجيب رصيده. مثال: "رصيد أبو خالد".';
  const match = await findCustomerByName(shopId, customerQuery, svcHeaders);
  if (match.status === 'none') return `ما لقيت زبون اسمه قريب من "${customerQuery}".`;
  if (match.status === 'ambiguous') return { __ambiguous: true, matches: match.matches };
  return replyCustomerBalance(match.customer, shopId, svcHeaders);
}

async function replyCustomerBalance(customer, shopId, svcHeaders) {
  const [salesRes, paymentsRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/sales?shop_id=eq.${shopId}&customer_id=eq.${customer.id}&is_deleted=eq.false&select=paid_debt`, { headers: svcHeaders }),
    fetch(`${SUPABASE_URL}/rest/v1/payments?shop_id=eq.${shopId}&customer_id=eq.${customer.id}&is_deleted=eq.false&select=amount,discount`, { headers: svcHeaders })
  ]);
  const sales = await salesRes.json();
  const payments = await paymentsRes.json();
  const debtTotal = (Array.isArray(sales) ? sales : []).reduce((s, x) => s + (x.paid_debt || 0), 0);
  const paidTotal = (Array.isArray(payments) ? payments : []).reduce((s, x) => s + (x.amount || 0) + (x.discount || 0), 0);
  const balance = debtTotal - paidTotal;

  if (balance > 0) return `رصيد ${customer.name}: عليه ${formatMoneyPlainRemote(balance)}.`;
  if (balance < 0) return `رصيد ${customer.name}: له ${formatMoneyPlainRemote(-balance)} (دفع أكثر من المطلوب).`;
  return `رصيد ${customer.name}: لا يوجد عليه أي مبلغ مستحق حاليًا.`;
}

// ---------- النية 2: فواتير زبون لفترة (مع فلترة اختيارية بالملاحظات) ----------
async function handleIntentCustomerInvoices(shopId, parsed, svcHeaders) {
  if (!parsed.customer) return 'بدي اسم الزبون حتى أقدر أجيب فواتيره. مثال: "فواتير سامر".';
  const match = await findCustomerByName(shopId, parsed.customer, svcHeaders);
  if (match.status === 'none') return `ما لقيت زبون اسمه قريب من "${parsed.customer}".`;
  if (match.status === 'ambiguous') return { __ambiguous: true, matches: match.matches };
  return replyCustomerInvoices(match.customer, parsed, shopId, svcHeaders);
}

async function replyCustomerInvoices(customer, parsed, shopId, svcHeaders) {
  let q = `${SUPABASE_URL}/rest/v1/sales?shop_id=eq.${shopId}&customer_id=eq.${customer.id}&is_deleted=eq.false`;
  // حدود اليوم/الفترة بتوقيت غزة المحلي لا منتصف ليل UTC (راجع gazaDayBoundsUtc) - مهم جدًا هنا تحديدًا
  // لأن from/to غالبًا تواريخ نسبية محسوبة ("اليوم"، "مبارح") بنفس التوقيت المحلي من classifyIntent.
  // ملاحظة: لا نكرّر "created_at=" كمفتاحين منفصلين بنفس الاسم (gte ثم lte) - رغم أن PostgREST يفترض أن
  // يدعم هذا، لوحظ فعليًا بالإنتاج أن الفلترة المزدوجة هكذا لا تُرجع أي نتيجة إطلاقًا حتى لفواتير مؤكَّد
  // وجودها بالفترة المطلوبة. نستخدم بدلًا منه بناء and=(...) الصريح الموثَّق بـPostgREST لتفادي أي التباس
  if (parsed.from && parsed.to) {
    q += `&and=(${encodeURIComponent(`created_at.gte.${gazaDayBoundsUtc(parsed.from).start},created_at.lte.${gazaDayBoundsUtc(parsed.to).end}`)})`;
  } else if (parsed.from) {
    q += `&created_at=gte.${encodeURIComponent(gazaDayBoundsUtc(parsed.from).start)}`;
  } else if (parsed.to) {
    q += `&created_at=lte.${encodeURIComponent(gazaDayBoundsUtc(parsed.to).end)}`;
  }
  if (parsed.note_contains) q += `&notes=ilike.${encodeURIComponent('%' + parsed.note_contains + '%')}`;
  q += '&select=invoice_number,total_amount,payment_status,notes,created_at&order=created_at.desc&limit=20';

  const res = await fetch(q, { headers: svcHeaders });
  const sales = await res.json();
  if (!Array.isArray(sales) || !sales.length) {
    // نوضّح الفترة المستخدَمة فعليًا بالبحث (لو كان بالرسالة تاريخ) - يفيد المستخدم مباشرة لمعرفة إذا
    // كان البحث بالفترة الصحيحة أصلًا، بدل رد عام قد يُخفي خطأ باستخراج التاريخ عن المستخدم والمطوّر معًا
    let rangeNote = '';
    if (parsed.from && parsed.to && parsed.from === parsed.to) rangeNote = ` (بتاريخ ${parsed.from})`;
    else if (parsed.from || parsed.to) rangeNote = ` (من ${parsed.from || '—'} إلى ${parsed.to || '—'})`;

    // تشخيص إضافي لو كان في فلتر تاريخ: نتحقق هل لهذا الزبون (بنفس customer_id المطابَق) أي فاتورة إطلاقًا
    // بغض النظر عن التاريخ. لو الجواب "لا يوجد ولا فاتورة"، الأرجح أنه زبون مكرَّر بنفس الاسم (customer_id
    // مختلف عن الفاتورة الفعلية الموجودة بالتطبيق) لا خطأ بفلتر التاريخ - نوضّح هذا الاحتمال للمستخدم مباشرة
    if (parsed.from || parsed.to) {
      const anyRes = await fetch(`${SUPABASE_URL}/rest/v1/sales?shop_id=eq.${shopId}&customer_id=eq.${customer.id}&is_deleted=eq.false&select=created_at&order=created_at.desc&limit=3`, { headers: svcHeaders });
      const anySales = await anyRes.json();
      if (!Array.isArray(anySales) || !anySales.length) {
        return `ما في ولا فاتورة مسجّلة لـ${customer.name} إطلاقًا بهالحساب. لو متأكد إنه إله فواتير، تأكد من صفحة الزبائن إنه ما في أكثر من زبون بنفس الاسم (قد يكون اسم مكرَّر بسجل مختلف).`;
      }
      // تشخيص مؤقت: نعرض التواريخ الخام (created_at) لآخر 3 فواتير فعليًا لهذا الزبون - لمعرفة هل فعلًا
      // تقع ضمن الفترة المطلوبة أو في خلل تنسيق/منطقة زمنية خفي بين التخزين الفعلي وحدود gazaDayBoundsUtc
      const rawDates = anySales.map(s => s.created_at).join(', ');
      return `ما في فواتير لـ${customer.name}${rangeNote} بهالشروط.\n(تشخيص مؤقت - آخر تواريخ فواتير فعلية له: ${rawDates})`;
    }
    return `ما في فواتير لـ${customer.name}${rangeNote} بهالشروط.`;
  }

  const STATUS_LABELS = { paid: 'مدفوعة', partial: 'جزئي', debt: 'دين' };
  const lines = sales.map(s => `• ${s.invoice_number} - ${formatMoneyPlainRemote(s.total_amount)} - ${STATUS_LABELS[s.payment_status] || s.payment_status} - ${formatDatePlainRemote(s.created_at)}${s.notes ? ` (${s.notes})` : ''}`);
  const suffix = sales.length === 20 ? '\n\n(عرضت آخر 20 فاتورة فقط)' : '';
  return `فواتير ${customer.name} (${sales.length}):\n${lines.join('\n')}${suffix}`;
}

// ---------- كشف حساب: رصيد الزبون + كل فواتيره معًا، دائمًا بدون فلترة تاريخ (راجع تعريف customer_statement
// بالبرومبت) - هذا بالضبط ما قصده مستخدم فعلي بعبارة "كشف حساب فلان" (وليس رصيد وحده أو فواتير وحدها) ----------
async function handleIntentCustomerStatement(shopId, customerQuery, svcHeaders) {
  if (!customerQuery) return 'بدي اسم الزبون حتى أقدر أجيب كشف حسابه. مثال: "كشف حساب أبو خالد".';
  const match = await findCustomerByName(shopId, customerQuery, svcHeaders);
  if (match.status === 'none') return `ما لقيت زبون اسمه قريب من "${customerQuery}".`;
  if (match.status === 'ambiguous') return { __ambiguous: true, matches: match.matches };
  return replyCustomerStatement(match.customer, shopId, svcHeaders);
}

async function replyCustomerStatement(customer, shopId, svcHeaders) {
  const [balanceText, invoicesText] = await Promise.all([
    replyCustomerBalance(customer, shopId, svcHeaders),
    replyCustomerInvoices(customer, {}, shopId, svcHeaders)
  ]);
  return `كشف حساب ${customer.name}:\n\n${balanceText}\n\n${invoicesText}`;
}

// ---------- النية 3: مبيعات اليوم ----------
async function handleIntentTodaySales(shopId, svcHeaders) {
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Gaza' }).format(new Date());
  const { start, end } = gazaDayBoundsUtc(todayStr);

  // راجع التعليق بـreplyCustomerInvoices: and=(...) الصريح بدل تكرار created_at= كمفتاحين منفصلين
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/sales?shop_id=eq.${shopId}&is_deleted=eq.false&and=(${encodeURIComponent(`created_at.gte.${start},created_at.lte.${end}`)})&select=total_amount,paid_cash,paid_transfer,paid_debt`,
    { headers: svcHeaders }
  );
  const sales = await res.json();
  if (!Array.isArray(sales) || !sales.length) return 'لا توجد مبيعات اليوم حتى الآن.';

  const total = sales.reduce((s, x) => s + (x.total_amount || 0), 0);
  const cash = sales.reduce((s, x) => s + (x.paid_cash || 0), 0);
  const transfer = sales.reduce((s, x) => s + (x.paid_transfer || 0), 0);
  const debt = sales.reduce((s, x) => s + (x.paid_debt || 0), 0);
  return `مبيعات اليوم: ${sales.length} فاتورة بإجمالي ${formatMoneyPlainRemote(total)}.\n💵 نقدي: ${formatMoneyPlainRemote(cash)}\n📱 تحويل: ${formatMoneyPlainRemote(transfer)}\n📝 آجل: ${formatMoneyPlainRemote(debt)}`;
}

// ---------- النية 4: أكثر 10 زبائن عليهم ديون ----------
async function handleIntentTopDebtors(shopId, svcHeaders) {
  const custRes = await fetch(`${SUPABASE_URL}/rest/v1/customers?shop_id=eq.${shopId}&is_deleted=eq.false&select=id,name,phone`, { headers: svcHeaders });
  const customers = await custRes.json();
  if (!Array.isArray(customers) || !customers.length) return 'لا يوجد زبائن مسجَّلون بعد.';

  // نُعيد استخدام نفس دالة حساب الرصيد المستخدمة أصلًا لتذكيرات SMS (fetchBalancesAndDueDates) حتى يبقى
  // رقم "أكثر الزبائن ديونًا" مطابقًا دائمًا لنفس الرصيد الظاهر بالتطبيق وبرسالة "رصيد زبون" أعلاه تمامًا
  const { balances } = await fetchBalancesAndDueDates(customers, svcHeaders, shopId);
  const debtors = customers
    .map(c => ({ ...c, balance: balances.get(c.id) || 0 }))
    .filter(c => c.balance > 0)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 10);

  if (!debtors.length) return 'لا يوجد زبائن عليهم ديون حاليًا 🎉';
  const lines = debtors.map((c, i) => `${i + 1}. ${c.name} - ${formatMoneyPlainRemote(c.balance)}`);
  return `أكثر ${debtors.length} زبائن ديونًا:\n${lines.join('\n')}`;
}

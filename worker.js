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
    return env.ASSETS.fetch(request);
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

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
  },

  // يُستدعى تلقائيًا حسب جدول cron المضبوط بـ wrangler.toml (كل 15 دقيقة) - يفحص جدولات SMS المستحقة ويرسلها
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processDueSmsSchedules(env));
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
      await processOneSchedule(schedule, svcHeaders, env);
    } catch (e) {
      console.error('فشلت معالجة جدولة SMS', schedule.id, e);
    }
  }
}

async function processOneSchedule(schedule, svcHeaders, env) {
  const tplRes = await fetch(`${SUPABASE_URL}/rest/v1/sms_templates?id=eq.${schedule.template_id}&select=*`, { headers: svcHeaders });
  const templates = await tplRes.json();
  const template = Array.isArray(templates) ? templates[0] : null;
  if (!template) { await markScheduleDone(schedule, svcHeaders); return; }

  const shopRes = await fetch(`${SUPABASE_URL}/rest/v1/shops?id=eq.${schedule.shop_id}&select=name`, { headers: svcHeaders });
  const shops = await shopRes.json();
  const shopName = (Array.isArray(shops) && shops[0]?.name) || '';

  let custQuery = `shop_id=eq.${schedule.shop_id}&is_deleted=eq.false&sms_excluded=eq.false`;
  if (schedule.target !== 'all') custQuery += `&payment_cycle=eq.${schedule.target}`;
  const custRes = await fetch(`${SUPABASE_URL}/rest/v1/customers?${custQuery}&select=*`, { headers: svcHeaders });
  const customers = await custRes.json();

  for (const customer of (Array.isArray(customers) ? customers : [])) {
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

    await fetch(`${SUPABASE_URL}/rest/v1/sms_log`, {
      method: 'POST', headers: svcHeaders,
      body: JSON.stringify({
        shop_id: schedule.shop_id, schedule_id: schedule.id, customer_id: customer.id,
        customer_name: customer.name, phone: customer.phone || '', message,
        scheduled_at: schedule.scheduled_at, sent_at: new Date().toISOString(),
        status: result.success ? 'sent' : 'failed', error: result.error || null
      })
    });
  }

  await markScheduleDone(schedule, svcHeaders);
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

async function markScheduleDone(schedule, svcHeaders) {
  if (schedule.recurring === 'once') {
    await fetch(`${SUPABASE_URL}/rest/v1/sms_schedules?id=eq.${schedule.id}`, {
      method: 'PATCH', headers: svcHeaders, body: JSON.stringify({ status: 'completed' })
    });
  } else {
    const days = schedule.recurring === 'weekly' ? 7 : 30;
    const next = new Date(schedule.scheduled_at);
    next.setDate(next.getDate() + days);
    await fetch(`${SUPABASE_URL}/rest/v1/sms_schedules?id=eq.${schedule.id}`, {
      method: 'PATCH', headers: svcHeaders, body: JSON.stringify({ scheduled_at: next.toISOString() })
    });
  }
}

// ---------- التكامل مع مزوّد TweetSMS (tweetsms.ps) ----------
// المفتاح والمرسل يُقرآن من أسرار Cloudflare (SMS_PROVIDER_API_KEY / SMS_PROVIDER_SENDER) - لا يوجدان بالكود أبدًا
// تنسيق الرد الدقيق من المزوّد غير موثّق هنا؛ نعتمد كشفًا مبدئيًا للنجاح/الفشل يُدقَّق فور وصول أول ردود فعلية بالسجل
async function sendSms(phone, message, env) {
  const apiKey = env.SMS_PROVIDER_API_KEY;
  if (!apiKey) return { success: false, error: 'السرّ SMS_PROVIDER_API_KEY غير مضبوط على Cloudflare Workers' };

  const normalizedPhone = normalizePalestinianPhone(phone);
  if (!normalizedPhone) return { success: false, error: `رقم هاتف غير صالح: ${phone}` };

  const params = new URLSearchParams({
    comm: 'sendsms',
    api_key: apiKey,
    to: normalizedPhone,
    message,
    sender: env.SMS_PROVIDER_SENDER || 'TweetTEST'
  });

  try {
    const res = await fetch(`https://tweetsms.ps/api.php?${params.toString()}`);
    const text = (await res.text()).trim();
    if (!res.ok) return { success: false, error: `فشل الاتصال بمزوّد SMS (HTTP ${res.status}): ${text.slice(0, 300)}` };
    if (/error|fail|invalid|خطأ|فشل/i.test(text)) return { success: false, error: text.slice(0, 300) };
    return { success: true };
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

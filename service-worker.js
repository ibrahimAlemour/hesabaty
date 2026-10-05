// Service Worker: يجعل التطبيق يعمل بالكامل بدون إنترنت (Offline-first)
const CACHE_NAME = 'hesabaty-cache-v18';
const RUNTIME_CACHE = 'hesabaty-runtime-v18';

// الملفات "الحرجة" التي يجب أن ينجح تخزينها لتفعيل نسخة جديدة من Service Worker: بدونها التطبيق لا
// يعمل إطلاقًا حتى بالوضع الأساسي. باقي الشاشات (sales.js, reports.js...) غير حرجة لأنها تُجلب وتُخزَّن
// تلقائيًا بأول طلب فعلي لها عبر معالج fetch أدناه (Network-first + تخزين تلقائي عند النجاح)
const CRITICAL_SHELL = [
  './', './index.html', './manifest.json', './css/style.css',
  './js/app.js', './js/database.js', './js/db-indexeddb.js', './js/db-supabase.js',
  './js/sync.js', './js/auth.js', './js/ui.js', './js/utils.js'
];

const APP_SHELL = [
  ...CRITICAL_SHELL,
  './css/responsive.css',
  './js/attachments.js',
  './js/cash.js',
  './js/cashier.js',
  './js/customers.js',
  './js/dashboard.js',
  './js/debts.js',
  './js/expenses.js',
  './js/invoice.js',
  './js/login.js',
  './js/products.js',
  './js/inventory.js',
  './js/categories.js',
  './js/sms.js',
  './js/reports.js',
  './js/sales.js',
  './js/search.js',
  './js/settings.js',
  './js/seed.js',
  './js/setup.js',
  './js/suppliers.js',
  './js/purchases.js',
  './js/transfers.js',
  './js/welcome.js',
  './js/saas-config.js',
  './js/pwa-install.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-192.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  // نخزّن كل ملف على حدة بدل cache.addAll() (التي تفشل بالكامل لو فشل ملف واحد فقط) - على اتصال بطيء
  // جدًا أو متقطع يكفي فشل تحميل ملف واحد لإسقاط التفعيل كله ويبقى المستخدم عالقًا بلا أي نسخة محفوظة تعمل.
  //
  // مهم جدًا: skipWaiting() (الذي يفرض استبدال النسخة القديمة الشغّالة فورًا) لا يُستدعى إلا إذا نجح تخزين
  // كل الملفات "الحرجة" (CRITICAL_SHELL). لو فشل أي منها (اتصال سيئ جدًا وقت التحديث تحديدًا، كما حصل فعليًا)
  // تبقى النسخة القديمة الكاملة الشغّالة مسيطرة دون أي تغيير، وسيُعاد تلقائيًا محاولة التثبيت بزيارة لاحقة
  // بدل استبدال نسخة كاملة تعمل بنسخة جديدة قد تكون ناقصة وقت اتصال سيئ تحديدًا
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const results = await Promise.allSettled(APP_SHELL.map((url) => cache.add(url)));
      const failedUrls = APP_SHELL.filter((_, i) => results[i].status === 'rejected');
      if (failedUrls.length) console.warn(`[service-worker] تعذّر تخزين ${failedUrls.length} من ${APP_SHELL.length} ملفًا مسبقًا:`, failedUrls);

      const criticalFailed = failedUrls.some((url) => CRITICAL_SHELL.includes(url));
      if (criticalFailed) {
        console.warn('[service-worker] فشل تخزين ملفات حرجة - لن تُفعَّل هذه النسخة؛ تبقى النسخة الحالية الشغّالة كما هي');
        return; // بدون skipWaiting(): هذه النسخة تبقى "بانتظار" حتى تُثبَّت بنجاح لاحقًا، ولا تُفعَّل بحالة ناقصة
      }
      self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // قبل حذف نسخة التخزين القديمة: ننقل لها أي ملف فشل تخزينه بالنسخة الجديدة أثناء install (اتصال
      // سيئ جدًا كما حصل فعليًا) إن كان محفوظًا بنجاح بالنسخة القديمة - حتى لا يفقد المستخدم كليًا أي ملف
      // كان يعمل بنجاح قبل التحديث
      const oldKey = keys.find((k) => k !== CACHE_NAME && k.startsWith('hesabaty-cache-'));
      if (oldKey) {
        const [newCache, oldCache] = await Promise.all([caches.open(CACHE_NAME), caches.open(oldKey)]);
        for (const url of APP_SHELL) {
          if (await newCache.match(url)) continue;
          const fromOld = await oldCache.match(url);
          if (fromOld) await newCache.put(url, fromOld);
        }
      }
      await Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== RUNTIME_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

// يفرض حدًا زمنيًا على fetch حتى لا تتعلّق الصفحة بانتظار شبكة ضعيفة/متقطعة (لا "أوف لاين" بشكل صريح يفشل فورًا،
// بل اتصال بطيء جدًا أو DNS متعثر قد يستغرق دقائق ليفشل من نفسه) - نفترضه فاشلاً بعد المهلة ونرجع للنسخة المخزّنة
function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fetch-timeout')), ms);
    fetch(request).then((res) => { clearTimeout(timer); resolve(res); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    // تنقّل/فتح التطبيق نفسه (الصفحة الرئيسية): نرجع النسخة المخزّنة فورًا بدون انتظار الشبكة أبدًا، حتى يفتح التطبيق
    // بثقة ولحظيًا سواء أوف لاين أو باتصال ضعيف/متعثر، مع تحديث النسخة المخزّنة بالخلفية بصمت إن توفر إنترنت
    if (request.mode === 'navigate') {
      event.respondWith(
        caches.match('./index.html').then((cached) => {
          // request.clone() ضروري هنا: نفس كائن Request لا يمكن استخدامه بـfetch() أكثر من مرة، وهذا التحديث
          // بالخلفية يعمل بالتوازي مع طلب fetch احتياطي محتمل أدناه (لو لم توجد نسخة مخزّنة) على نفس الطلب الأصلي -
          // استخدام نفس الكائن مرتين يرمي خطأً غير مُعالَج يظهر للمتصفح كـERR_FAILED فاشل تمامًا لفتح الصفحة
          fetchWithTimeout(request.clone(), 4000).then((response) => {
            if (response && response.ok) caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', response.clone()));
          }).catch(() => {});
          return cached || fetchWithTimeout(request, 4000).catch(() => new Response('', { status: 503 }));
        })
      );
      return;
    }

    // باقي ملفات التطبيق (JS/CSS): Network-first بمهلة محدودة يضمن ظهور أي تحديث فورًا عند وجود إنترنت سليم
    // مع سقوط سريع للنسخة المحلية عند انقطاع الاتصال أو تعثّره لمدة طويلة
    event.respondWith(
      fetchWithTimeout(request, 4000).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      }).catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // مكتبات خارجية (Chart.js / Supabase) - Cache-first ثم تحديث بالخلفية للعمل offline بعد أول تحميل
  event.respondWith(
    caches.open(RUNTIME_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const networkFetch = fetch(request).then((response) => {
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      }).catch(() => null);
      return cached || networkFetch || new Response('', { status: 504 });
    })
  );
});

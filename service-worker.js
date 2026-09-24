// Service Worker: يجعل التطبيق يعمل بالكامل بدون إنترنت (Offline-first)
const CACHE_NAME = 'hesabaty-cache-v6';
const RUNTIME_CACHE = 'hesabaty-runtime-v6';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './css/responsive.css',
  './js/app.js',
  './js/auth.js',
  './js/cash.js',
  './js/customers.js',
  './js/dashboard.js',
  './js/database.js',
  './js/db-indexeddb.js',
  './js/db-supabase.js',
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
  './js/settings.js',
  './js/seed.js',
  './js/setup.js',
  './js/sync.js',
  './js/transfers.js',
  './js/ui.js',
  './js/utils.js',
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
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== CACHE_NAME && k !== RUNTIME_CACHE).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
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
          fetchWithTimeout(request, 4000).then((response) => {
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

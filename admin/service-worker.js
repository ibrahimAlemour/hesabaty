// Service Worker خاص بلوحة المدير العام - يُسجَّل بنطاق (scope) /admin/ فقط، منفصل عن تطبيق المحل
const CACHE_NAME = 'hesabaty-admin-cache-v2';
const RUNTIME_CACHE = 'hesabaty-admin-runtime-v2';

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/admin.css',
  './js/admin-app.js',
  './js/admin-auth.js',
  './js/admin-db.js',
  './js/admin-login.js',
  './js/admin-dashboard.js',
  './js/admin-shops.js',
  './js/admin-settings.js',
  './js/admin-utils.js',
  '../css/style.css',
  '../css/responsive.css',
  '../js/ui.js',
  '../js/pwa-install.js',
  '../assets/icons/icon-192.png',
  '../assets/icons/icon-512.png',
  '../assets/icons/icon-maskable-192.png',
  '../assets/icons/icon-maskable-512.png',
  '../assets/icons/favicon-32.png'
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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        return response;
      }).catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

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

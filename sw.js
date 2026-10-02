// ═══════════════════════════════════════════════════════════
// SERVICE WORKER - Visor Tarimas v8
// ═══════════════════════════════════════════════════════════

const CACHE_VERSION = 'visor-v10';   // ⚠️ v7 → v8 para forzar actualización
const CACHE_NAME = CACHE_VERSION;

const ARCHIVOS_CACHE = [
  './',
  './index.html',
  './scanner.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './usuarios.json',
  './icono_192x192.png',   // ⚠️ NUEVO: cachear el favicon
  './icono_512x512.png'    // ⚠️ NUEVO: cachear el favicon grande
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARCHIVOS_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  if (url.includes('script.google.com') ||
      url.includes('cdn.jsdelivr.net') ||
      url.includes('cdnjs.cloudflare.com')) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        }).catch(() => cachedResponse);

        return cachedResponse || fetchPromise;
      });
    })
  );
});

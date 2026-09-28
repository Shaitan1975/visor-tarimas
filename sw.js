// ═══════════════════════════════════════════════════════════
// SERVICE WORKER - Visor Tarimas v3
// Estrategia: Cache-first con actualización automática
// Los usuarios NUNCA ven caché viejo
// ═══════════════════════════════════════════════════════════

// Cambia esta versión cuando hagas cambios MAYORES
// Los usuarios se actualizarán automáticamente
const CACHE_VERSION = 'visor-v1';
const CACHE_NAME = CACHE_VERSION;

const ARCHIVOS_CACHE = [
  './',
  './index.html',
  './scanner.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './usuarios.json'
];

// ─── Instalar: cachear archivos básicos ───
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ARCHIVOS_CACHE))
  );
  self.skipWaiting();
});

// ─── Activar: borrar cachés viejos ───
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      );
    }).then(() => self.clients.claim())
  );
});

// ─── Fetch: stale-while-revalidate ───
// Devuelve caché INMEDIATAMENTE + actualiza en segundo plano
self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // No interceptar llamadas a servicios externos
  if (url.includes('script.google.com') ||
      url.includes('cdn.jsdelivr.net') ||
      url.includes('cdnjs.cloudflare.com')) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.match(event.request).then((cachedResponse) => {
        // Fetch en segundo plano para actualizar el caché
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

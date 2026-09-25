// ═══════════════════════════════════════════════════════════
// SERVICE WORKER - Cachea los archivos para uso offline
// ═══════════════════════════════════════════════════════════

const CACHE_NAME = 'visor-tarimas-v1';
const ARCHIVOS_CACHE = [
  './',
  './index.html',
  './scanner.html',
  './app.js',
  './styles.css',
  './manifest.json',
  './usuarios.json'
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
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // No interceptar peticiones a Google Apps Script ni a CDNs externos
  const url = event.request.url;
  if (url.includes('script.google.com') ||
      url.includes('cdn.jsdelivr.net') ||
      url.includes('cdnjs.cloudflare.com')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((resp) => resp || fetch(event.request))
  );
});

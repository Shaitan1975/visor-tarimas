// ═══════════════════════════════════════════════════════════
// SERVICE WORKER - Visor Tarimas
// ═══════════════════════════════════════════════════════════

// 🔴 CAMBIA ESTE NÚMERO cada vez que actualices la app
const CACHE_VERSION = 'v4';
const CACHE_NAME = 'visor-tarimas-' + CACHE_VERSION;

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
  // Fuerza al SW nuevo a activarse inmediatamente
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
  // No interceptar llamadas a servicios externos
  if (url.includes('script.google.com') ||
      url.includes('cdn.jsdelivr.net')) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then((resp) => resp || fetch(event.request))
  );
});

// ═══════════════════════════════════════════════════════════════════
// VISOR TARIMAS - SERVICE WORKER v22
// Red primero para la app (así los celulares siempre reciben la última
// versión); si no hay internet, se usa la copia guardada.
// Las llamadas al servidor (script.google.com) nunca se guardan.
// Al publicar cambios: sube el número de CACHE.
// ═══════════════════════════════════════════════════════════════════

const CACHE = "visor-v28b-20261023";
const ARCHIVOS = [
  "./",
  "./index.html",
  "./scanner.html",
  "./app.js",
  "./qrcode.min.js",
  "./styles.css",
  "./manifest.json",
  "./icono_192x192.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // servidor y CDNs: directo a la red

  e.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp && resp.status === 200) {
          const copia = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copia));
        }
        return resp;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((r) =>
          r || (req.mode === "navigate" ? caches.match("./index.html") : undefined)
        )
      )
  );
});

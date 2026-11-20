/* Clauden web — service worker: offline shell, network-first for API. */

const VERSION = "clauden-v12";
const SHELL = [
  "/",
  "/index.html",
  "/css/app.css",
  "/css/landing.css",
  "/assets/logo.svg?v=9",
  "/assets/mascot.svg?v=9",
  "/icons/icon-192.png?v=9",
  "/icons/icon-512.png?v=9",
  "/manifest.webmanifest",
  "/vendor/marked.min.js",
  "/vendor/purify.min.js",
  "/vendor/highlight.min.js",
  "/fonts/anthropic_sans.ttf",
  "/fonts/anthropic_serif.ttf",
  "/fonts/jetbrains_mono.ttf",
];

const OFFLINE_HTML = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clauden — нет соединения</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111;color:#eee;font:16px/1.5 system-ui,sans-serif;text-align:center}
div{max-width:420px;padding:24px}h1{font-size:20px;margin:0 0 8px}p{color:#aaa;margin:0 0 20px}
button{border:0;border-radius:10px;padding:10px 22px;font-size:15px;cursor:pointer;background:#e8734a;color:#fff}</style>
</head><body><div><h1>Нет соединения</h1><p>Не удалось загрузить Clauden. Проверьте интернет и попробуйте снова.</p>
<button onclick="location.reload()">Повторить</button></div></body></html>`;

/* respondWith ВСЕГДА должен получать Response. Раньше при пустом кэше
   fallback возвращал undefined → «Failed to convert value to 'Response'». */
function offlineResponse(request) {
  const path = new URL(request.url).pathname;
  const html = request.mode === "navigate" || path.endsWith(".html") || path === "/";
  return new Response(html ? OFFLINE_HTML : "", {
    status: 503,
    statusText: "Offline",
    headers: { "content-type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" },
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    /* Один битый ассет не должен ронять всю установку — иначе кэш остаётся
       пустым и навигация офлайн падает. */
    await Promise.allSettled(SHELL.map(async (path) => {
      const res = await fetch(new Request(path, { cache: "reload" }));
      if (res.ok) await cache.put(path, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/files/") || url.pathname.startsWith("/app/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () =>
        (await caches.match("/index.html")) || (await caches.match("/")) || offlineResponse(request)),
    );
    return;
  }

  // Код и стили — network-first: после деплоя пользователь сразу видит
  // новую версию, а офлайн остаётся кэш.
  if (url.pathname.startsWith("/js/") || url.pathname.startsWith("/css/")) {
    event.respondWith(
      fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      }).catch(async () => (await caches.match(request)) || offlineResponse(request)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok && (url.pathname.startsWith("/vendor/") || url.pathname.startsWith("/fonts/"))) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return response;
      } catch {
        return offlineResponse(request);
      }
    }),
  );
});

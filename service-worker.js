const CACHE = "librarium-v38";
const FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./assets/librarium-icon.svg",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (e) => {
  if (e.data?.type === "SKIP_WAITING") self.skipWaiting();
});

function isNetworkFirstRequest(request, url) {
  if (request.mode === "navigate") return true;
  const path = url.pathname;
  return (
    path === "/" ||
    path.endsWith("/index.html") ||
    path.endsWith("/manifest.json") ||
    path.endsWith("/service-worker.js")
  );
}

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/src/") ||
    url.pathname.startsWith("/@") ||
    url.pathname.startsWith("/node_modules/")
  ) {
    return;
  }

  if (isNetworkFirstRequest(e.request, url)) {
    e.respondWith(
      fetch(e.request, { cache: "no-cache" })
        .then((r) => {
          if (r.ok && r.type === "basic") {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return r;
        })
        .catch(() => caches.match(e.request).then((cached) => cached || caches.match("./index.html")))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(
      (cached) =>
        cached ||
        fetch(e.request)
          .then((r) => {
            if (r.ok && r.type === "basic") {
              const copy = r.clone();
              caches.open(CACHE).then((c) => c.put(e.request, copy));
            }
            return r;
          })
          .catch(() => caches.match("./index.html"))
    )
  );
});

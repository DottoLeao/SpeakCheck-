/* SpeakCheck service worker.
   Strategy chosen to never trap users on a stale version:
   - HTML (/ and /admin): network-first, cache fallback (offline still opens the app)
   - Static assets + CDN (fonts, lucide, motion): stale-while-revalidate
   - /api/*: network-only — never cached */
const V = "sc-v1";
const CORE = ["/", "/manifest.json", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // API calls: always live, never cached.
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) return;

  // App HTML: network-first so deploys land immediately; cache keeps it working offline.
  const isHTML = url.origin === location.origin &&
    (url.pathname === "/" || url.pathname === "/admin" || url.pathname.endsWith(".html"));
  if (isHTML) {
    e.respondWith(
      fetch(req)
        .then((r) => {
          const copy = r.clone();
          caches.open(V).then((c) => c.put(req, copy));
          return r;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Everything else (same-origin statics + CDN fonts/libs): stale-while-revalidate.
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req)
        .then((r) => {
          if (r && r.status === 200 && (r.type === "basic" || r.type === "cors")) {
            const copy = r.clone();
            caches.open(V).then((c) => c.put(req, copy));
          }
          return r;
        })
        .catch(() => cached);
      return cached || net;
    })
  );
});

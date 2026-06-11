// Mail Brief service worker: keeps the app shell available offline.
// Mail data itself is cached by the page in localStorage; replies written
// offline queue in the page's outbox. This worker only guarantees the app
// opens with no connection.
const CACHE = "mailbrief-shell-v1";
const SHELL = ["/", "/manifest.json", "/icon-180.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for our own pages (so updates arrive normally), cache fallback
// when offline. Cross-origin requests (the database) pass through untouched —
// the page handles those failures itself.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return resp;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then(hit => hit || caches.match("/")))
  );
});

// Offline cache for the workout log page only. It never sees workout data:
// the log lives in localStorage and is not part of any request.
const CACHE = "orkestr-free-workout-log-v1";
const PAGE = "/free/workout-log";
const ASSETS = [
  PAGE,
  "/free/workout-log/app.css",
  "/free/workout-log/app.js",
  "/free/workout-log/progression.js",
  "/free/workout-log/store.js",
  "/free/workout-log/timer.js",
  "/favicon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith("orkestr-free-workout-log-") && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

// Network first so updates arrive when online; cached copy when offline.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !ASSETS.includes(url.pathname)) return;
  event.respondWith(fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
    }
    return response;
  }).catch(() => caches.match(url.pathname).then((cached) => cached || Response.error())));
});

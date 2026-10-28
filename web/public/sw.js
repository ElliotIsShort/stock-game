/*
 * Stonker service worker: makes the site installable and opens instantly.
 * - Hashed build assets (/_next/static/) are cache-first: their URLs change on every deploy.
 * - Pages are network-first, falling back to the last cached copy when offline.
 * - Everything cross-origin (Firestore, Cloud Functions, Google sign-in) is left alone.
 * Bump VERSION to drop old caches.
 */
const VERSION = "v1";
const CACHE = `stonker-${VERSION}`;
const SCOPE = new URL(self.registration.scope).pathname;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("stonker-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
  return res;
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res.ok) (await caches.open(CACHE)).put(request, res.clone());
    return res;
  } catch (err) {
    const cached = (await caches.match(request)) || (await caches.match(SCOPE));
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE)) return;
  if (url.pathname.includes("/_next/static/")) {
    event.respondWith(cacheFirst(request));
  } else if (request.mode === "navigate" || url.pathname.endsWith(".webmanifest") || url.pathname.includes("/icons/")) {
    event.respondWith(networkFirst(request));
  }
});

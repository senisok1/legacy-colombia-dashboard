// Phase 5 (PWA, 2026-08-08): minimal service worker whose only real jobs are
// (a) satisfying the browser's "installable to home screen" requirement and
// (b) caching the small fixed set of icon/manifest assets that genuinely
// never change between deploys.
//
// Deliberately NETWORK-ONLY for everything else — no page HTML, no /api/*
// responses, nothing dynamic. This is a live operational dashboard: guest
// messages, pending WhatsApp approvals, bookings, and financials all change
// by the minute. A service worker that cached any of that would risk
// showing Seni stale data with no visible warning — after the trouble this
// project has already had with a missed-message bug (see
// check-messages/route.ts's incident history), the dashboard itself quietly
// lying about what's current is not a trade worth making for offline
// support this app doesn't actually need. If real offline support is ever
// wanted, it needs to be scoped deliberately (e.g. read-only cached views
// with an explicit "last updated" indicator), not bolted on here.
const CACHE_NAME = "lc-dashboard-static-v1";
const STATIC_ASSETS = [
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/favicon.ico",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .catch(() => {}) // a failed pre-cache shouldn't block installation
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!STATIC_ASSETS.includes(url.pathname)) return; // everything else: normal network fetch, untouched

  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});

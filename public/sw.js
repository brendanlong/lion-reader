/**
 * Lion Reader Service Worker
 *
 * Handles:
 * 1. PWA installation and basic caching
 * 2. Offline fallback for navigation requests
 *
 * Share Target API POST requests are handled server-side by /api/share/route.ts
 */

const CACHE_NAME = "lion-reader-v1";

// Static assets to cache on install
const PRECACHE_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/android-chrome-192x192.png",
  "/android-chrome-512x512.png",
];

// Install event - cache static assets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch event - network first with offline fallback
self.addEventListener("fetch", (event) => {
  // Only handle navigation requests (not API calls, assets, etc.)
  if (event.request.mode !== "navigate") {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => {
      // If offline, serve cached homepage
      return caches.match("/");
    })
  );
});

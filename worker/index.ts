/**
 * Lion Reader Custom Service Worker Extensions
 *
 * This file extends the auto-generated service worker from next-pwa.
 * It handles:
 * 1. Offline fallback for navigation requests
 *
 * Note: The main caching of Next.js static assets is handled by next-pwa's
 * Workbox configuration in next.config.ts. This file only adds custom handlers.
 *
 * Share Target API POST requests are handled server-side by /api/share/route.ts
 */

// Service worker global scope - 'self' refers to the service worker context
// Use 'any' to bypass strict type checking for service worker-specific APIs
// that aren't fully typed in the standard lib.webworker
const sw = self as unknown as ServiceWorkerGlobalScope & typeof globalThis;

// FetchEvent type for service workers
interface SWFetchEvent extends Event {
  readonly request: Request;
  readonly clientId: string;
  respondWith(response: Response | Promise<Response>): void;
}

// Offline fallback for navigation requests
// When a user navigates while offline, serve the cached homepage
sw.addEventListener("fetch", ((event: SWFetchEvent) => {
  // Only handle navigation requests (not API calls, assets, etc.)
  // Assets are handled by Workbox's precaching and runtime caching
  if (event.request.mode !== "navigate") {
    return;
  }

  // For navigation requests, try network first, fall back to cached homepage
  event.respondWith(
    fetch(event.request).catch(async () => {
      // If offline, try to serve cached homepage from Workbox precache
      const cache = await caches.open("workbox-precache-v2");
      const cachedResponse = await cache.match("/");
      if (cachedResponse) {
        return cachedResponse;
      }
      // Fallback to the offline page that Workbox may have cached
      const offlineResponse = await caches.match("/~offline");
      if (offlineResponse) {
        return offlineResponse;
      }
      // Last resort: return a basic offline response
      return new Response("You are offline", {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "Content-Type": "text/plain" },
      });
    })
  );
}) as EventListener);

export {};

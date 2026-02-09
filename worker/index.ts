/**
 * Lion Reader Custom Service Worker Extensions
 *
 * This file extends the auto-generated service worker from next-pwa.
 * It handles:
 * 1. Share Target API for URLs and files
 * 2. Offline fallback for navigation requests
 *
 * For URL shares, the service worker redirects to /save which handles
 * saving the article and auto-closes itself.
 *
 * File shares store the file in IndexedDB and redirect to /save for processing.
 *
 * Note: The main caching of Next.js static assets is handled by next-pwa's
 * Workbox configuration in next.config.ts. This file only adds custom handlers.
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

// Helper to convert File/Blob to base64
async function fileToBase64(file: File | Blob): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Handle share target POST requests
sw.addEventListener("fetch", ((event: SWFetchEvent) => {
  const url = new URL(event.request.url);

  // Intercept share target POST requests
  if (url.pathname === "/api/share" && event.request.method === "POST") {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          const sharedFile = formData.get("file") as File | null;
          const sharedUrl = formData.get("url")?.toString();
          const sharedText = formData.get("text")?.toString();
          const sharedTitle = formData.get("title")?.toString();

          if (sharedFile) {
            // File was shared - store in IndexedDB for the /save page to process
            const base64Content = await fileToBase64(sharedFile);

            // Open IndexedDB to store the file
            const dbRequest = indexedDB.open("lion-reader-share", 1);

            dbRequest.onupgradeneeded = () => {
              const db = dbRequest.result;
              if (!db.objectStoreNames.contains("files")) {
                db.createObjectStore("files");
              }
            };

            await new Promise<void>((resolve, reject) => {
              dbRequest.onsuccess = () => {
                const db = dbRequest.result;
                const transaction = db.transaction("files", "readwrite");
                const store = transaction.objectStore("files");

                // Store file data with a key
                store.put(
                  {
                    content: base64Content,
                    filename: sharedFile.name,
                    type: sharedFile.type,
                    title: sharedTitle || null,
                    timestamp: Date.now(),
                  },
                  "pending"
                );

                transaction.oncomplete = () => {
                  db.close();
                  resolve();
                };
                transaction.onerror = () => {
                  db.close();
                  reject(transaction.error);
                };
              };
              dbRequest.onerror = () => reject(dbRequest.error);
            });

            // Redirect to save page with file indicator
            const redirectUrl = new URL("/save", url.origin);
            redirectUrl.searchParams.set("type", "file");
            redirectUrl.searchParams.set("shared", "true");

            return Response.redirect(redirectUrl.toString(), 303);
          } else if (sharedUrl || sharedText) {
            // URL was shared - redirect to /save page which handles saving and auto-closes
            let urlToSave = sharedUrl;

            if (!urlToSave && sharedText) {
              // Try to extract URL from text
              const urlMatch = sharedText.match(/https?:\/\/[^\s]+/);
              if (urlMatch) {
                urlToSave = urlMatch[0];
              } else if (sharedText.startsWith("http")) {
                urlToSave = sharedText;
              }
            }

            if (!urlToSave) {
              const errorUrl = new URL("/save", url.origin);
              errorUrl.searchParams.set("error", "no_url");
              return Response.redirect(errorUrl.toString(), 303);
            }

            const saveUrl = new URL("/save", url.origin);
            saveUrl.searchParams.set("url", urlToSave);
            saveUrl.searchParams.set("shared", "true");
            return Response.redirect(saveUrl.toString(), 303);
          } else {
            // No file or URL found
            const errorUrl = new URL("/save", url.origin);
            errorUrl.searchParams.set("error", "no_url_or_file");
            return Response.redirect(errorUrl.toString(), 303);
          }
        } catch (error) {
          console.error("Share target error:", error);
          const errorUrl = new URL("/save", url.origin);
          errorUrl.searchParams.set("error", "share_failed");
          return Response.redirect(errorUrl.toString(), 303);
        }
      })()
    );
    return; // Don't continue to other handlers
  }

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

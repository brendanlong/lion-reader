/**
 * Lion Reader Custom Service Worker Extensions
 *
 * This file extends the auto-generated service worker from next-pwa.
 * It handles:
 * 1. Share Target API for URLs and files
 * 2. Offline fallback for navigation requests
 *
 * For URL shares, the service worker saves directly via the API without
 * showing any intermediate UI. Open tabs are notified via postMessage so
 * the RealtimeProvider can show a toast.
 *
 * With launch_handler: focus-existing in the manifest, Chrome on Android
 * focuses the existing PWA window instead of navigating it. The service
 * worker's fetch handler still fires for the POST, and the postMessage
 * reaches the focused window. When the app is NOT already open,
 * focus-existing falls back to navigate-new, and the service worker
 * redirects to the app root with query params for the toast.
 *
 * File shares still redirect to /save because they require more complex processing.
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

// Message types for communicating with open tabs
interface ShareResultMessage {
  type: "share-result";
  success: boolean;
  url?: string;
  title?: string;
  error?: string;
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

/**
 * Notifies all open Lion Reader tabs about a share result.
 * Uses postMessage to send the result to all controlled clients.
 */
async function notifyClients(message: ShareResultMessage): Promise<void> {
  const clients = await sw.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage(message);
  }
}

/**
 * Attempts to save a URL directly via the API without navigation.
 * Returns the saved article title on success, or throws an error.
 */
async function saveUrlDirectly(url: string, origin: string): Promise<{ title: string | null }> {
  const apiUrl = `${origin}/api/v1/saved`;

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include", // Include session cookie
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      throw new Error("NOT_AUTHENTICATED");
    }

    throw new Error(data.error?.message || `HTTP ${response.status}`);
  }

  const data = await response.json();
  return { title: data.article?.title || null };
}

/**
 * Returns the best URL to redirect to after a share completes.
 * Android's share target destroys the PWA's navigation state, so we
 * redirect back into the app. We check existing clients for an app page
 * URL to restore, falling back to the root.
 */
async function getRedirectUrl(origin: string): Promise<string> {
  const clients = await sw.clients.matchAll({ type: "window" });
  // Look for an existing client on an app page (not /api/share, /save, etc.)
  for (const client of clients) {
    const clientUrl = new URL(client.url);
    if (
      clientUrl.origin === origin &&
      !clientUrl.pathname.startsWith("/api/") &&
      !clientUrl.pathname.startsWith("/save") &&
      !clientUrl.pathname.startsWith("/login")
    ) {
      return client.url;
    }
  }
  return `${origin}/`;
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
            // URL was shared - try to save directly without navigation
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

            // Try to save directly via API (no navigation)
            try {
              const result = await saveUrlDirectly(urlToSave, url.origin);

              // Notify any existing tabs (may not be received if this is the only window)
              await notifyClients({
                type: "share-result",
                success: true,
                url: urlToSave,
                title: result.title || undefined,
              });

              // Redirect back into the app with share result in query params.
              // The postMessage above may not be received because Android's share
              // target destroys the current page, so we pass the result via URL
              // for the app to show a toast after loading.
              const redirectUrl = new URL(await getRedirectUrl(url.origin));
              redirectUrl.searchParams.set("shared", "saved");
              if (result.title) {
                redirectUrl.searchParams.set("sharedTitle", result.title);
              }
              return Response.redirect(redirectUrl.toString(), 303);
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : "Unknown error";

              // If not authenticated, redirect to /save for login flow
              if (errorMessage === "NOT_AUTHENTICATED") {
                const saveUrl = new URL("/save", url.origin);
                saveUrl.searchParams.set("url", urlToSave);
                saveUrl.searchParams.set("shared", "true");
                return Response.redirect(saveUrl.toString(), 303);
              }

              // Notify any existing tabs
              await notifyClients({
                type: "share-result",
                success: false,
                url: urlToSave,
                error: errorMessage,
              });

              // Redirect back into the app with error in query params
              const redirectUrl = new URL(await getRedirectUrl(url.origin));
              redirectUrl.searchParams.set("shared", "error");
              redirectUrl.searchParams.set("sharedError", errorMessage);
              return Response.redirect(redirectUrl.toString(), 303);
            }
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

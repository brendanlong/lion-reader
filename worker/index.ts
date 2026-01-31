/**
 * Lion Reader Custom Service Worker Extensions
 *
 * This file extends the auto-generated service worker from next-pwa.
 * It handles:
 * 1. Share Target API for URLs and files
 * 2. Offline fallback for navigation requests
 *
 * For URL shares, the service worker attempts to save directly via the API
 * without navigation, then notifies open tabs via postMessage. This allows
 * sharing to Lion Reader from within Lion Reader without losing the current page.
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
 * Returns an HTML page that shows a success/error message and closes itself.
 * Used as a fallback when the share was handled in the service worker.
 */
function createResultPage(success: boolean, message: string, details?: string): Response {
  const bgColor = success ? "#16a34a" : "#dc2626";
  const icon = success ? "✓" : "✕";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${success ? "Saved" : "Error"} - Lion Reader</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #18181b;
      color: #fafafa;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }
    .container {
      max-width: 320px;
      width: 100%;
      text-align: center;
    }
    .icon {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: ${bgColor};
      color: white;
      font-size: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1rem;
    }
    h1 {
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    .details {
      font-size: 0.875rem;
      color: #a1a1aa;
      word-break: break-word;
    }
    .closing {
      margin-top: 1rem;
      font-size: 0.75rem;
      color: #71717a;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">${icon}</div>
    <h1>${message}</h1>
    ${details ? `<p class="details">${details}</p>` : ""}
    <p class="closing">Closing...</p>
  </div>
  <script>
    // Try to close the window/tab, or go back
    setTimeout(() => {
      if (window.opener || window.history.length <= 1) {
        window.close();
      } else {
        window.history.back();
      }
    }, 1500);
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
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

              // Notify all open tabs about the successful save
              await notifyClients({
                type: "share-result",
                success: true,
                url: urlToSave,
                title: result.title || undefined,
              });

              // Return a success page that auto-closes
              return createResultPage(true, "Saved!", result.title || urlToSave);
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : "Unknown error";

              // If not authenticated, redirect to /save for login flow
              if (errorMessage === "NOT_AUTHENTICATED") {
                const saveUrl = new URL("/save", url.origin);
                saveUrl.searchParams.set("url", urlToSave);
                saveUrl.searchParams.set("shared", "true");
                return Response.redirect(saveUrl.toString(), 303);
              }

              // Notify all open tabs about the error
              await notifyClients({
                type: "share-result",
                success: false,
                url: urlToSave,
                error: errorMessage,
              });

              // Return an error page
              return createResultPage(false, "Failed to save", errorMessage);
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

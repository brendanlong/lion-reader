/**
 * Lion Reader Custom Service Worker Extensions
 *
 * This file extends the auto-generated service worker from next-pwa.
 * It handles:
 * 1. Offline fallback for navigation requests
 * 2. Background Sync for offline mutations (read/starred)
 *
 * Note: The main caching of Next.js static assets is handled by next-pwa's
 * Workbox configuration in next.config.ts. This file only adds custom handlers.
 *
 * Share Target API POST requests are handled server-side by /api/share/route.ts
 */

import { MutationQueueStore, MAX_RETRIES } from "../src/lib/mutation-queue/store";
import type {
  QueuedMutation,
  MutationQueueMessage,
  MutationResultMessage,
  MutationQueueStatusMessage,
} from "../src/lib/mutation-queue/types";

// Service worker global scope
declare const self: ServiceWorkerGlobalScope;

// Background Sync tag for mutation queue
const MUTATION_SYNC_TAG = "mutation-queue-sync";

// Store instance (shared across handlers)
let mutationStore: MutationQueueStore | null = null;

function getStore(): MutationQueueStore {
  if (!mutationStore) {
    mutationStore = new MutationQueueStore();
  }
  return mutationStore;
}

/**
 * Broadcast a message to all clients.
 */
async function broadcastToClients(message: MutationResultMessage | MutationQueueStatusMessage) {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const client of clients) {
    client.postMessage(message);
  }
}

/**
 * Process a single mutation by calling the API.
 */
async function processMutation(mutation: QueuedMutation): Promise<boolean> {
  const store = getStore();

  try {
    // Mark as processing
    await store.update({ ...mutation, status: "processing" });

    let result: MutationResultMessage["result"];

    if (mutation.type === "markRead") {
      const response = await fetch("/api/trpc/entries.markRead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          json: {
            entries: [{ id: mutation.entryId, changedAt: mutation.changedAt }],
            read: mutation.read,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      result = { entries: data.result?.data?.json?.entries };
    } else if (mutation.type === "star") {
      const response = await fetch("/api/trpc/entries.star", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          json: {
            id: mutation.entryId,
            changedAt: mutation.changedAt,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      result = { entry: data.result?.data?.json?.entry };
    } else if (mutation.type === "unstar") {
      const response = await fetch("/api/trpc/entries.unstar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          json: {
            id: mutation.entryId,
            changedAt: mutation.changedAt,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      result = { entry: data.result?.data?.json?.entry };
    }

    // Success - remove from queue and notify clients
    await store.remove(mutation.id);

    await broadcastToClients({
      type: "MUTATION_RESULT",
      mutationId: mutation.id,
      success: true,
      result,
    });

    return true;
  } catch (error) {
    console.error("Mutation failed:", error);

    const newRetryCount = mutation.retryCount + 1;
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    if (newRetryCount >= MAX_RETRIES) {
      // Max retries reached, mark as failed
      await store.update({
        ...mutation,
        status: "failed",
        retryCount: newRetryCount,
        lastError: errorMessage,
      });

      await broadcastToClients({
        type: "MUTATION_RESULT",
        mutationId: mutation.id,
        success: false,
        error: errorMessage,
      });
    } else {
      // Reset to pending for retry
      await store.update({
        ...mutation,
        status: "pending",
        retryCount: newRetryCount,
        lastError: errorMessage,
      });
    }

    return false;
  }
}

/**
 * Process all pending mutations in the queue.
 */
async function processQueue() {
  const store = getStore();

  // Notify clients we're syncing
  await broadcastToClients({
    type: "MUTATION_QUEUE_STATUS",
    pendingCount: await store.getPendingCount(),
    isSyncing: true,
  });

  try {
    let pending = await store.getPending();

    while (pending.length > 0) {
      const mutation = pending[0];
      await processMutation(mutation);

      // Refresh pending list
      pending = await store.getPending();
    }
  } finally {
    // Notify clients we're done syncing
    await broadcastToClients({
      type: "MUTATION_QUEUE_STATUS",
      pendingCount: await store.getPendingCount(),
      isSyncing: false,
    });
  }
}

// Handle messages from main thread
self.addEventListener("message", async (event: ExtendableMessageEvent) => {
  const data = event.data as MutationQueueMessage;

  if (data.type === "QUEUE_MUTATION") {
    const store = getStore();

    // Remove any existing mutations for this entry (deduplication)
    await store.removeAllForEntry(data.mutation.entryId);

    // Add the new mutation
    await store.add(data.mutation);

    // Update pending count
    const pendingCount = await store.getPendingCount();
    await broadcastToClients({
      type: "MUTATION_QUEUE_STATUS",
      pendingCount,
      isSyncing: false,
    });

    // Register for Background Sync if available
    if ("sync" in self.registration) {
      try {
        await self.registration.sync.register(MUTATION_SYNC_TAG);
      } catch {
        // Background Sync not supported or permission denied
        // Fall back to immediate processing if online
        if (navigator.onLine) {
          processQueue();
        }
      }
    } else if (navigator.onLine) {
      // No Background Sync support, process immediately if online
      processQueue();
    }
  }
});

// Handle Background Sync events
self.addEventListener("sync", (event: SyncEvent) => {
  if (event.tag === MUTATION_SYNC_TAG) {
    event.waitUntil(processQueue());
  }
});

// Offline fallback for navigation requests
// When a user navigates while offline, serve the cached homepage
self.addEventListener("fetch", ((event: FetchEvent) => {
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

/**
 * RealtimeProvider Component
 *
 * Manages the SSE connection for real-time updates and optionally displays
 * a connection status indicator.
 *
 * Also handles messages from the service worker (e.g., share target results)
 * to show toast notifications.
 *
 * This component should be used in the app layout to enable real-time updates
 * for authenticated users.
 */

"use client";

import { type ReactNode, useEffect } from "react";
import { toast } from "sonner";
import { useSearchParams, useRouter } from "next/navigation";
import { useRealtimeUpdates, type SyncCursors } from "@/lib/hooks/useRealtimeUpdates";
import { ConnectionStatusIndicator } from "./ConnectionStatusIndicator";

/**
 * Message format from service worker for share target results.
 */
interface ShareResultMessage {
  type: "share-result";
  success: boolean;
  url?: string;
  title?: string;
  error?: string;
}

interface RealtimeProviderProps {
  /**
   * Child components to render.
   */
  children: ReactNode;

  /**
   * Initial sync cursors from server (one per entity type).
   * Used for SSE reconnection and polling mode to avoid missing events.
   */
  initialCursors: SyncCursors;

  /**
   * Whether to show the connection status indicator.
   * @default true
   */
  showStatusIndicator?: boolean;
}

/**
 * Provider component that manages real-time updates via SSE.
 *
 * Wraps the app content and handles:
 * - SSE connection management
 * - React Query cache invalidation on events
 * - Optional connection status indicator
 *
 * @example
 * ```tsx
 * // In your app layout:
 * export default function AppLayout({ children }) {
 *   // Initial cursors - null values for fresh sync
 *   const initialCursors: SyncCursors = {
 *     entries: null, entryStates: null, subscriptions: null,
 *     removedSubscriptions: null, tags: null
 *   };
 *   return (
 *     <RealtimeProvider initialCursors={initialCursors}>
 *       {children}
 *     </RealtimeProvider>
 *   );
 * }
 * ```
 */
export function RealtimeProvider({
  children,
  initialCursors,
  showStatusIndicator = true,
}: RealtimeProviderProps) {
  const { status, reconnect } = useRealtimeUpdates(initialCursors);
  const searchParams = useSearchParams();
  const router = useRouter();

  // Check for share result query params (set by service worker redirect after
  // Android share target). Android destroys the PWA's navigation state on share,
  // so postMessage may not reach the new page. The SW passes the result via URL.
  useEffect(() => {
    const shared = searchParams.get("shared");
    if (!shared) return;

    if (shared === "saved") {
      const title = searchParams.get("sharedTitle");
      toast.success("Article saved", {
        description: title || undefined,
      });
    } else if (shared === "error") {
      const error = searchParams.get("sharedError");
      toast.error("Failed to save article", {
        description: error || undefined,
      });
    }

    // Clean up query params without a full navigation
    const url = new URL(window.location.href);
    url.searchParams.delete("shared");
    url.searchParams.delete("sharedTitle");
    url.searchParams.delete("sharedError");
    router.replace(url.pathname + url.search, { scroll: false });
  }, [searchParams, router]);

  // Set up launchQueue consumer for focus-existing launch_handler.
  // When the PWA is already open and receives a share target launch,
  // the browser focuses this window and enqueues a LaunchParams instead of
  // navigating. The service worker's fetch handler does the actual saving
  // and sends a postMessage (handled below). We just need to consume the
  // launch event so the browser doesn't fall back to default behavior.
  useEffect(() => {
    if (!("launchQueue" in window)) return;

    (
      window as {
        launchQueue: { setConsumer: (cb: (params: { targetURL?: string }) => void) => void };
      }
    ).launchQueue.setConsumer(() => {
      // The service worker handles the actual save via its fetch event
      // handler and notifies us via postMessage. Nothing to do here.
    });
  }, []);

  // Listen for messages from service worker (e.g., share target results)
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      const data = event.data as ShareResultMessage | undefined;

      if (data?.type === "share-result") {
        if (data.success) {
          toast.success("Article saved", {
            description: data.title || data.url,
          });
        } else {
          toast.error("Failed to save article", {
            description: data.error || data.url,
          });
        }
      }
    };

    navigator.serviceWorker.addEventListener("message", handleMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", handleMessage);
    };
  }, []);

  return (
    <>
      {children}
      {showStatusIndicator && <ConnectionStatusIndicator status={status} onReconnect={reconnect} />}
    </>
  );
}

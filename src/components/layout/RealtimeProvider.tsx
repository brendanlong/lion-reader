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

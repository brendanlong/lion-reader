/**
 * RealtimeProvider Component
 *
 * Manages the SSE connection for real-time updates and displays a connection
 * status indicator.
 *
 * This component should be used in the app layout to enable real-time updates
 * for authenticated users.
 */

"use client";

import { type ReactNode } from "react";
import { useRealtimeUpdates } from "@/lib/hooks/useRealtimeUpdates";
import { type SyncCursors } from "@/lib/events/cursors";
import { ConnectionStatusIndicator } from "./ConnectionStatusIndicator";

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
}

/**
 * Provider component that manages real-time updates via SSE.
 *
 * Wraps the app content and handles:
 * - SSE connection management
 * - React Query cache invalidation on events
 * - Connection status indicator
 *
 * @example
 * ```tsx
 * // In your app layout:
 * export default function AppLayout({ children }) {
 *   // Initial cursors - null values for fresh sync
 *   const initialCursors: SyncCursors = {
 *     entries: null, entriesAfterId: null, subscriptions: null, tags: null
 *   };
 *   return (
 *     <RealtimeProvider initialCursors={initialCursors}>
 *       {children}
 *     </RealtimeProvider>
 *   );
 * }
 * ```
 */
export function RealtimeProvider({ children, initialCursors }: RealtimeProviderProps) {
  const { status, reconnect } = useRealtimeUpdates(initialCursors);

  return (
    <>
      {children}
      <ConnectionStatusIndicator status={status} onReconnect={reconnect} />
    </>
  );
}

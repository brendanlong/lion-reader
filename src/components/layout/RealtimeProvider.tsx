/**
 * RealtimeProvider Component
 *
 * Manages the SSE connection for real-time updates and optionally displays
 * a connection status indicator.
 *
 * This component should be used in the app layout to enable real-time updates
 * for authenticated users.
 */

"use client";

import { type ReactNode } from "react";
import { useRealtimeUpdates, type SyncCursors } from "@/lib/hooks/useRealtimeUpdates";
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

  return (
    <>
      {children}
      {showStatusIndicator && <ConnectionStatusIndicator status={status} onReconnect={reconnect} />}
    </>
  );
}

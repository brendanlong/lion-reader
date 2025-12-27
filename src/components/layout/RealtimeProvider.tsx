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
import { useRealtimeUpdates } from "@/lib/hooks/useRealtimeUpdates";
import { ConnectionStatusIndicator } from "./ConnectionStatusIndicator";

interface RealtimeProviderProps {
  /**
   * Child components to render.
   */
  children: ReactNode;

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
 *   return (
 *     <RealtimeProvider>
 *       {children}
 *     </RealtimeProvider>
 *   );
 * }
 * ```
 */
export function RealtimeProvider({ children, showStatusIndicator = true }: RealtimeProviderProps) {
  const { status, reconnect } = useRealtimeUpdates();

  return (
    <>
      {children}
      {showStatusIndicator && <ConnectionStatusIndicator status={status} onReconnect={reconnect} />}
    </>
  );
}

/**
 * ConnectionStatusIndicator Component
 *
 * Displays the current SSE connection status in a subtle, non-intrusive way.
 * Shows a small indicator when the connection is not active.
 */

"use client";

import { type ConnectionStatus } from "@/lib/events/connection-state";

interface ConnectionStatusIndicatorProps {
  /**
   * Current connection status.
   */
  status: ConnectionStatus;

  /**
   * Callback to manually trigger a reconnection.
   */
  onReconnect?: () => void;
}

/**
 * Displays the connection status as a small indicator.
 *
 * - Connected: Shows a small green dot (or nothing for minimal UI)
 * - Connecting: Shows a pulsing indicator
 * - Disconnected/Error: Shows status with reconnect option
 */
export function ConnectionStatusIndicator({ status, onReconnect }: ConnectionStatusIndicatorProps) {
  // Don't show anything when connected
  if (status === "connected") {
    return null;
  }

  return (
    <div
      className="ui-text-sm bg-surface fixed right-4 bottom-4 z-50 flex items-center gap-2 rounded-full px-3 py-2 shadow-lg ring-1 ring-zinc-200 dark:ring-zinc-700"
      role="status"
      aria-live="polite"
    >
      {status === "connecting" && (
        <>
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-yellow-500" />
          </span>
          <span className="text-muted">Connecting...</span>
        </>
      )}

      {(status === "disconnected" || status === "error") && (
        <>
          <span className="relative flex h-2 w-2">
            <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
          </span>
          <span className="text-muted">
            {status === "error" ? "Connection error" : "Disconnected"}
          </span>
          {onReconnect && (
            <button onClick={onReconnect} className="text-strong ml-1 underline hover:no-underline">
              Retry
            </button>
          )}
        </>
      )}
    </div>
  );
}

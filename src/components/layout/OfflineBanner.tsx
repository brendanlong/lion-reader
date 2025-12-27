/**
 * OfflineBanner Component
 *
 * Displays a banner when the user is offline.
 * Uses navigator.onLine and online/offline events to detect network status.
 */

"use client";

import { useState, useEffect, useRef, useCallback, memo } from "react";

/**
 * Get initial online status for SSR-safe initialization.
 */
function getInitialOnlineStatus(): boolean {
  // Return true for SSR, actual value on client
  if (typeof window === "undefined") {
    return true;
  }
  return navigator.onLine;
}

/**
 * Custom hook to track online/offline status.
 * Returns online status and a flag for showing reconnected message.
 */
function useOnlineStatus(): { isOnline: boolean; showReconnected: boolean } {
  // Initialize with actual value if on client, true for SSR
  const [isOnline, setIsOnline] = useState(getInitialOnlineStatus);
  const [showReconnected, setShowReconnected] = useState(false);

  // Track if we were offline to show reconnected message
  const wasOfflineRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleOnline = useCallback(() => {
    setIsOnline(true);

    // Show reconnected message if we were offline
    if (wasOfflineRef.current) {
      setShowReconnected(true);
      wasOfflineRef.current = false;

      // Clear any existing timer
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      // Hide the reconnected message after 3 seconds
      timerRef.current = setTimeout(() => {
        setShowReconnected(false);
        timerRef.current = null;
      }, 3000);
    }
  }, []);

  const handleOffline = useCallback(() => {
    setIsOnline(false);
    wasOfflineRef.current = true;
    setShowReconnected(false);

    // Clear any existing timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);

      // Clean up timer on unmount
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [handleOnline, handleOffline]);

  return { isOnline, showReconnected };
}

interface OfflineBannerProps {
  /**
   * Additional CSS classes.
   */
  className?: string;
}

/**
 * OfflineBanner component.
 * Shows a warning banner when offline, hides when online.
 */
export const OfflineBanner = memo(function OfflineBanner({ className = "" }: OfflineBannerProps) {
  const { isOnline, showReconnected } = useOnlineStatus();

  // Don't render anything if online and not showing reconnected message
  if (isOnline && !showReconnected) {
    return null;
  }

  if (!isOnline) {
    return (
      <div
        role="alert"
        className={`flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-sm font-medium text-white ${className}`}
      >
        <svg
          className="h-4 w-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414"
          />
        </svg>
        <span>You are offline. Some features may not be available.</span>
      </div>
    );
  }

  // Show reconnected message
  return (
    <div
      role="status"
      className={`flex items-center justify-center gap-2 bg-green-500 px-4 py-2 text-sm font-medium text-white ${className}`}
    >
      <svg
        className="h-4 w-4"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"
        />
      </svg>
      <span>You are back online.</span>
    </div>
  );
});

/**
 * Export the useOnlineStatus hook for use in other components.
 */
export { useOnlineStatus };

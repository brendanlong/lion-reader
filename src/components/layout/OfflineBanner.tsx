/**
 * OfflineBanner Component
 *
 * Displays a banner when the user is offline.
 * Uses navigator.onLine and online/offline events to detect network status.
 */

"use client";

import { useSyncExternalStore, memo } from "react";

// --- External store for online status using useSyncExternalStore pattern ---

// Listeners for raw online status changes
const onlineStatusListeners = new Set<() => void>();

// Listeners for reconnected state changes
const reconnectedListeners = new Set<() => void>();

// Global state for reconnected message
let showReconnectedState = false;
let wasOffline = false;
let reconnectedTimer: ReturnType<typeof setTimeout> | null = null;

// Subscribe to online/offline events (lazy initialization)
let isSubscribed = false;

function ensureSubscribed(): void {
  if (isSubscribed || typeof window === "undefined") return;
  isSubscribed = true;

  window.addEventListener("online", () => {
    // Notify online status listeners
    onlineStatusListeners.forEach((listener) => listener());

    // Handle reconnected state
    if (wasOffline) {
      wasOffline = false;
      showReconnectedState = true;
      reconnectedListeners.forEach((listener) => listener());

      // Clear any existing timer
      if (reconnectedTimer) {
        clearTimeout(reconnectedTimer);
      }

      // Hide the reconnected message after 3 seconds
      reconnectedTimer = setTimeout(() => {
        showReconnectedState = false;
        reconnectedTimer = null;
        reconnectedListeners.forEach((listener) => listener());
      }, 3000);
    }
  });

  window.addEventListener("offline", () => {
    // Notify online status listeners
    onlineStatusListeners.forEach((listener) => listener());

    // Track that we were offline and hide any reconnected message
    wasOffline = true;
    if (showReconnectedState) {
      showReconnectedState = false;
      reconnectedListeners.forEach((listener) => listener());
    }
    if (reconnectedTimer) {
      clearTimeout(reconnectedTimer);
      reconnectedTimer = null;
    }
  });
}

function subscribeToOnlineStatus(callback: () => void): () => void {
  ensureSubscribed();
  onlineStatusListeners.add(callback);
  return () => {
    onlineStatusListeners.delete(callback);
  };
}

function subscribeToReconnected(callback: () => void): () => void {
  ensureSubscribed();
  reconnectedListeners.add(callback);
  return () => {
    reconnectedListeners.delete(callback);
  };
}

function getOnlineStatusSnapshot(): boolean {
  return typeof window !== "undefined" ? navigator.onLine : true;
}

function getOnlineStatusServerSnapshot(): boolean {
  return true; // Assume online during SSR
}

function getReconnectedSnapshot(): boolean {
  return showReconnectedState;
}

function getReconnectedServerSnapshot(): boolean {
  return false; // Never show reconnected during SSR
}

/**
 * Custom hook to track online/offline status using useSyncExternalStore.
 * Returns online status and a flag for showing reconnected message.
 */
function useOnlineStatus(): { isOnline: boolean; showReconnected: boolean } {
  // Use useSyncExternalStore for both the online status and reconnected state
  const isOnline = useSyncExternalStore(
    subscribeToOnlineStatus,
    getOnlineStatusSnapshot,
    getOnlineStatusServerSnapshot
  );

  const showReconnected = useSyncExternalStore(
    subscribeToReconnected,
    getReconnectedSnapshot,
    getReconnectedServerSnapshot
  );

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
        className={`ui-text-sm flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 font-medium text-white ${className}`}
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
      className={`ui-text-sm flex items-center justify-center gap-2 bg-green-500 px-4 py-2 font-medium text-white ${className}`}
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

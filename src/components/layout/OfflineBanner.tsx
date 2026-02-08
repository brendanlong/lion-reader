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

import { WifiOffIcon, WifiOnIcon } from "@/components/ui/icon-button";

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
        <WifiOffIcon className="h-4 w-4" />
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
      <WifiOnIcon className="h-4 w-4" />
      <span>You are back online.</span>
    </div>
  );
});

/**
 * Export the useOnlineStatus hook for use in other components.
 */

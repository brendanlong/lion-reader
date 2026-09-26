/**
 * OfflineBanner Component
 *
 * Displays a banner when the user is offline.
 * Uses navigator.onLine and online/offline events to detect network status.
 */

"use client";

import { useSyncExternalStore } from "react";
import { WifiOffIcon, WifiOnIcon } from "@/components/ui/icons";

// --- External store for online status using useSyncExternalStore pattern ---

// Notified on any change to the online status or the reconnected message
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

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
    if (wasOffline) {
      wasOffline = false;
      showReconnectedState = true;

      // Clear any existing timer
      if (reconnectedTimer) {
        clearTimeout(reconnectedTimer);
      }

      // Hide the reconnected message after 3 seconds
      reconnectedTimer = setTimeout(() => {
        showReconnectedState = false;
        reconnectedTimer = null;
        notify();
      }, 3000);
    }
    notify();
  });

  window.addEventListener("offline", () => {
    // Track that we were offline and hide any reconnected message
    wasOffline = true;
    showReconnectedState = false;
    if (reconnectedTimer) {
      clearTimeout(reconnectedTimer);
      reconnectedTimer = null;
    }
    notify();
  });
}

function subscribe(callback: () => void): () => void {
  ensureSubscribed();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/**
 * OfflineBanner component.
 * Shows a warning banner when offline, hides when online.
 */
export function OfflineBanner() {
  const isOnline = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true // Assume online during SSR
  );
  const showReconnected = useSyncExternalStore(
    subscribe,
    () => showReconnectedState,
    () => false // Never show reconnected during SSR
  );

  if (!isOnline) {
    return (
      <div
        role="alert"
        className="ui-text-sm bg-warning-banner text-warning-banner-foreground flex items-center justify-center gap-2 px-4 py-2 font-medium"
      >
        <WifiOffIcon className="h-4 w-4" />
        <span>You are offline. Some features may not be available.</span>
      </div>
    );
  }

  if (!showReconnected) {
    return null;
  }

  return (
    <div
      role="status"
      className="ui-text-sm bg-success-banner text-success-banner-foreground flex items-center justify-center gap-2 px-4 py-2 font-medium"
    >
      <WifiOnIcon className="h-4 w-4" />
      <span>You are back online.</span>
    </div>
  );
}

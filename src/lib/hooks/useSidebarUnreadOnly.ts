"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * useSidebarUnreadOnly Hook
 *
 * Manages whether the sidebar shows only tags/subscriptions with unread entries.
 * State is persisted to localStorage.
 *
 * Uses useSyncExternalStore to avoid hydration mismatches - the server
 * always renders with unreadOnly=true (default), and the client reads from
 * localStorage after hydration.
 */

const STORAGE_KEY = "lion-reader-sidebar-unread-only";

// In-memory cache to avoid re-reading localStorage on every subscription
let cachedValue: boolean | null = null;
let listeners: Array<() => void> = [];

function getValue(): boolean {
  if (cachedValue !== null) {
    return cachedValue;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      cachedValue = stored === "true";
      return cachedValue;
    }
  } catch (error) {
    console.error("Failed to read sidebar unread only from localStorage:", error);
  }

  // Default: show only unread
  cachedValue = true;
  return cachedValue;
}

function setValue(newValue: boolean): void {
  cachedValue = newValue;

  try {
    localStorage.setItem(STORAGE_KEY, String(newValue));
  } catch (error) {
    console.error("Failed to save sidebar unread only to localStorage:", error);
  }

  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getSnapshot(): boolean {
  return getValue();
}

// Server always returns true (default: unread only)
function getServerSnapshot(): boolean {
  return true;
}

export interface UseSidebarUnreadOnlyResult {
  /** Whether to show only tags/subscriptions with unread entries */
  sidebarUnreadOnly: boolean;
  /** Toggle the sidebar unread filter */
  toggleSidebarUnreadOnly: () => void;
}

export function useSidebarUnreadOnly(): UseSidebarUnreadOnlyResult {
  const sidebarUnreadOnly = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggleSidebarUnreadOnly = useCallback(() => {
    setValue(!getValue());
  }, []);

  return {
    sidebarUnreadOnly,
    toggleSidebarUnreadOnly,
  };
}

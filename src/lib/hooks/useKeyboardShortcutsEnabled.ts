/**
 * useKeyboardShortcutsEnabled Hook
 *
 * Manages the keyboard shortcuts enabled state, persisted in localStorage.
 * Provides a way to enable/disable keyboard shortcuts globally.
 */

"use client";

import { useState, useCallback } from "react";

const STORAGE_KEY = "lion-reader:keyboard-shortcuts-enabled";

/**
 * Read the stored enabled state from localStorage.
 * Returns true (default) if not found or localStorage is not available.
 */
function getStoredEnabled(): boolean {
  if (typeof window === "undefined") {
    return true; // SSR default
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      return stored === "true";
    }
  } catch {
    // localStorage not available (private browsing)
  }
  return true; // default to enabled
}

/**
 * Hook to manage keyboard shortcuts enabled state.
 *
 * @returns Object with:
 *   - enabled: boolean - whether keyboard shortcuts are enabled
 *   - setEnabled: function to update the enabled state
 *   - isLoading: boolean - always false (kept for API compatibility)
 */
export function useKeyboardShortcutsEnabled() {
  // Use lazy initialization to read from localStorage
  const [enabled, setEnabledState] = useState(getStoredEnabled);

  // Update both state and localStorage
  const setEnabled = useCallback((value: boolean) => {
    setEnabledState(value);
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // localStorage not available
    }
  }, []);

  return {
    enabled,
    setEnabled,
    isLoading: false,
  };
}

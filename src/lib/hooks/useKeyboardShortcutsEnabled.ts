"use client";

import { useSyncExternalStore } from "react";

/**
 * useKeyboardShortcutsEnabled Hook
 *
 * Manages whether keyboard shortcuts are enabled globally.
 * State is persisted to localStorage.
 *
 * Uses useSyncExternalStore to avoid hydration mismatches - the server and the
 * hydration render both see enabled=true (default), and the client switches to
 * the stored value after hydration.
 */

const STORAGE_KEY = "lion-reader:keyboard-shortcuts-enabled";

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
    console.error("Failed to read keyboard shortcuts enabled from localStorage:", error);
  }

  // Default: shortcuts enabled
  cachedValue = true;
  return cachedValue;
}

function setValue(newValue: boolean): void {
  cachedValue = newValue;

  try {
    localStorage.setItem(STORAGE_KEY, String(newValue));
  } catch (error) {
    console.error("Failed to save keyboard shortcuts enabled to localStorage:", error);
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

// Server always returns true (default: shortcuts enabled)
function getServerSnapshot(): boolean {
  return true;
}

export interface UseKeyboardShortcutsEnabledResult {
  /** Whether keyboard shortcuts are enabled */
  enabled: boolean;
  /** Enable or disable keyboard shortcuts */
  setEnabled: (value: boolean) => void;
}

export function useKeyboardShortcutsEnabled(): UseKeyboardShortcutsEnabledResult {
  const enabled = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return {
    enabled,
    setEnabled: setValue,
  };
}

"use client";

import { useSyncExternalStore } from "react";

/**
 * A boolean preference persisted to localStorage and read through
 * useSyncExternalStore. The server snapshot (and so the hydration render) is
 * always `defaultValue`; the client switches to the stored value after
 * hydration, so SSR and hydration never disagree (#1552).
 */
export function createStoredBoolean(key: string, defaultValue: boolean) {
  // In-memory cache to avoid re-reading localStorage on every subscription
  let cachedValue: boolean | null = null;
  let listeners: Array<() => void> = [];

  function get(): boolean {
    if (cachedValue !== null) {
      return cachedValue;
    }
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        cachedValue = stored === "true";
        return cachedValue;
      }
    } catch (error) {
      console.error(`Failed to read ${key} from localStorage:`, error);
    }
    cachedValue = defaultValue;
    return cachedValue;
  }

  function set(newValue: boolean): void {
    cachedValue = newValue;
    try {
      localStorage.setItem(key, String(newValue));
    } catch (error) {
      console.error(`Failed to save ${key} to localStorage:`, error);
    }
    listeners.forEach((listener) => listener());
  }

  function subscribe(listener: () => void): () => void {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }

  return {
    get,
    set,
    useValue: (): boolean => useSyncExternalStore(subscribe, get, () => defaultValue),
  };
}

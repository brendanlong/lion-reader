"use client";

import { useSyncExternalStore } from "react";

/**
 * A preference persisted to localStorage and read through
 * useSyncExternalStore. The server snapshot (and so the hydration render) is
 * always `defaultValue`; the client switches to the stored value after
 * hydration, so SSR and hydration never disagree (#1552). `parse` returns null
 * for a stored string it doesn't recognize, which reads as the default.
 */
function createStoredValue<T>(key: string, defaultValue: T, parse: (stored: string) => T | null) {
  // In-memory cache to avoid re-reading localStorage on every subscription
  let cachedValue: { value: T } | null = null;
  let listeners: Array<() => void> = [];

  function get(): T {
    if (cachedValue !== null) {
      return cachedValue.value;
    }
    let value = defaultValue;
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) value = parse(stored) ?? defaultValue;
    } catch (error) {
      console.error(`Failed to read ${key} from localStorage:`, error);
    }
    cachedValue = { value };
    return value;
  }

  function set(newValue: T): void {
    cachedValue = { value: newValue };
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
    useValue: (): T => useSyncExternalStore(subscribe, get, () => defaultValue),
  };
}

export function createStoredBoolean(key: string, defaultValue: boolean) {
  return createStoredValue(key, defaultValue, (stored) => stored === "true");
}

/** One of `choices`, kept by its own string. */
export function createStoredChoice<T extends string>(
  key: string,
  choices: readonly T[],
  defaultValue: T
) {
  return createStoredValue(
    key,
    defaultValue,
    (stored) => choices.find((choice) => choice === stored) ?? null
  );
}

/**
 * Saves to localStorage under `key` the fields `next` changes from `prev`, on
 * top of what's stored there, so a field the user never set isn't written and
 * keeps following its default when that changes (#2280).
 */
export function storeChangedFields<T extends object>(key: string, prev: T, next: T): void {
  try {
    let stored: Partial<T> = {};
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        stored = parsed as Partial<T>;
      }
    } catch {
      // Unreadable: start over from the changes alone.
    }
    for (const field of Object.keys(next) as (keyof T)[]) {
      if (!Object.is(next[field], prev[field])) stored[field] = next[field];
    }
    localStorage.setItem(key, JSON.stringify(stored));
  } catch {
    // Silently fail if localStorage is full or unavailable
  }
}

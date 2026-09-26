"use client";

import { createStoredBoolean } from "@/lib/stored-boolean";

/**
 * Whether keyboard shortcuts are enabled globally (default: true), persisted
 * to localStorage.
 */
const store = createStoredBoolean("lion-reader:keyboard-shortcuts-enabled", true);

export interface UseKeyboardShortcutsEnabledResult {
  /** Whether keyboard shortcuts are enabled */
  enabled: boolean;
  /** Enable or disable keyboard shortcuts */
  setEnabled: (value: boolean) => void;
}

export function useKeyboardShortcutsEnabled(): UseKeyboardShortcutsEnabledResult {
  return { enabled: store.useValue(), setEnabled: store.set };
}

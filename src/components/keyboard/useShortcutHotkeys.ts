"use client";

import type { DependencyList } from "react";
import { useHotkeys, type HotkeyCallback } from "react-hotkeys-hook";
import { isDialogOpen } from "@/components/ui/dialog";

interface ShortcutHotkeyOptions {
  enabled: boolean;
  /** Match the produced character (`event.key`), for keys like `?` and `/` with no layout-independent code. */
  useKey?: boolean;
}

/**
 * Binds a page-level shortcut. Every app shortcut goes through this so none
 * fires while typing in a form field or behind an open dialog, which owns the
 * keyboard (its Escape handler can't stop other document listeners).
 */
export function useShortcutHotkeys(
  keys: string,
  callback: HotkeyCallback,
  options: ShortcutHotkeyOptions,
  deps?: DependencyList
): void {
  useHotkeys(
    keys,
    callback,
    { ...options, enableOnFormTags: false, ignoreEventWhen: isDialogOpen },
    deps
  );
}

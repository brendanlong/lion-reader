/**
 * KeyboardShortcutsModal Component
 *
 * Modal displaying all available keyboard shortcuts in the application.
 * Opens when user presses ? key.
 */

"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui";

/**
 * Shortcut definition for display
 */
interface Shortcut {
  keys: string[];
  description: string;
}

/**
 * Section of shortcuts grouped by context
 */
interface ShortcutSection {
  title: string;
  shortcuts: Shortcut[];
}

const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    title: "Navigation",
    shortcuts: [
      { keys: ["j"], description: "Next entry (in list or when viewing)" },
      { keys: ["k"], description: "Previous entry (in list or when viewing)" },
      { keys: ["o"], description: "Open selected entry" },
      { keys: ["Enter"], description: "Open selected entry" },
      { keys: ["Escape"], description: "Close entry / deselect" },
      { keys: ["g", "a"], description: "Go to All items" },
      { keys: ["g", "s"], description: "Go to Starred items" },
      { keys: ["g", "l"], description: "Go to Saved items" },
    ],
  },
  {
    title: "Actions",
    shortcuts: [
      { keys: ["m"], description: "Toggle read/unread" },
      { keys: ["s"], description: "Toggle star" },
      { keys: ["u"], description: "Toggle show/hide read items" },
      { keys: ["v"], description: "Open original URL in new tab" },
      { keys: ["r"], description: "Refresh current view" },
    ],
  },
  {
    title: "Narration",
    shortcuts: [
      { keys: ["p"], description: "Toggle play/pause" },
      { keys: ["Shift+N"], description: "Skip to next paragraph" },
      { keys: ["Shift+P"], description: "Skip to previous paragraph" },
    ],
  },
  {
    title: "Help",
    shortcuts: [{ keys: ["?"], description: "Show keyboard shortcuts" }],
  },
];

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsModal({ isOpen, onClose }: KeyboardShortcutsModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Focus trap and escape key handling
  useEffect(() => {
    if (!isOpen) return;

    // Focus the close button when dialog opens
    closeButtonRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Prevent body scroll when dialog is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />

      {/* Dialog */}
      <div
        ref={dialogRef}
        className="relative z-10 mx-4 max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-lg border border-zinc-200 bg-white p-6 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
      >
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <h2
            id="shortcuts-title"
            className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50"
          >
            Keyboard Shortcuts
          </h2>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 active:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Shortcut sections */}
        <div className="space-y-6">
          {SHORTCUT_SECTIONS.map((section) => (
            <div key={section.title}>
              <h3 className="ui-text-sm mb-3 font-medium text-zinc-500 dark:text-zinc-400">
                {section.title}
              </h3>
              <div className="space-y-2">
                {section.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.description}
                    className="flex items-center justify-between py-1"
                  >
                    <span className="ui-text-sm text-zinc-700 dark:text-zinc-300">
                      {shortcut.description}
                    </span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.map((key, index) => (
                        <span key={index} className="flex items-center gap-1">
                          {index > 0 && (
                            <span className="ui-text-xs text-zinc-400 dark:text-zinc-500">
                              then
                            </span>
                          )}
                          <kbd className="ui-text-xs inline-flex min-w-[24px] items-center justify-center rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 font-mono font-medium text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                            {key}
                          </kbd>
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="mt-6 border-t border-zinc-200 pt-4 dark:border-zinc-700">
          <p className="ui-text-xs text-zinc-500 dark:text-zinc-400">
            Keyboard shortcuts can be disabled in Settings.
          </p>
          <div className="mt-4 flex justify-end">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

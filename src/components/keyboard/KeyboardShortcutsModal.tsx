/**
 * KeyboardShortcutsModal Component
 *
 * Modal displaying all available keyboard shortcuts in the application.
 * Opens when user presses ? key.
 * Uses the reusable Dialog component.
 */

"use client";

import { useEffect, useRef } from "react";
import { Dialog, DialogHeader, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { IconButton, CloseIcon } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";

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
      { keys: ["/"], description: "Search entries" },
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
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Focus the close button when dialog opens
  useEffect(() => {
    if (isOpen) {
      closeButtonRef.current?.focus();
    }
  }, [isOpen]);

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Keyboard Shortcuts"
      titleId="shortcuts-title"
      size="lg"
      className="max-h-[80vh] overflow-y-auto"
    >
      {/* Header */}
      <DialogHeader className="flex items-center justify-between">
        <h2 id="shortcuts-title" className="ui-text-lg text-body font-semibold">
          Keyboard Shortcuts
        </h2>
        <IconButton
          ref={closeButtonRef}
          icon={<CloseIcon className="h-5 w-5" />}
          aria-label="Close"
          onClick={onClose}
        />
      </DialogHeader>

      {/* Shortcut sections */}
      <DialogBody className="space-y-6">
        {SHORTCUT_SECTIONS.map((section) => (
          <div key={section.title}>
            <h3 className="ui-text-sm text-muted mb-3 font-medium">{section.title}</h3>
            <div className="space-y-2">
              {section.shortcuts.map((shortcut) => (
                <div key={shortcut.description} className="flex items-center justify-between py-1">
                  <span className="ui-text-sm text-body">{shortcut.description}</span>
                  <div className="flex items-center gap-1">
                    {shortcut.keys.map((key, index) => (
                      <span key={index} className="flex items-center gap-1">
                        {index > 0 && <span className="ui-text-xs text-faint">then</span>}
                        <Kbd>{key}</Kbd>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </DialogBody>

      {/* Footer */}
      <DialogFooter className="border-edge-strong flex-col items-stretch border-t pt-4">
        <p className="ui-text-xs text-muted mb-4">
          Keyboard shortcuts can be disabled in Settings.
        </p>
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogFooter>
    </Dialog>
  );
}

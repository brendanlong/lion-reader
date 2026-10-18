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
import { IconButton } from "@/components/ui/icon-button";
import { CloseIcon } from "@/components/ui/icons";
import { Kbd } from "@/components/ui/kbd";
import {
  SHORTCUTS,
  SHORTCUT_SECTIONS,
  formatHotkey,
  hotkeyAlternatives,
  type ShortcutDefinition,
} from "./shortcuts";

const SHORTCUT_ROWS: [string, ShortcutDefinition][] = Object.entries(SHORTCUTS);

function ShortcutKeys({ shortcut }: { shortcut: ShortcutDefinition }) {
  return (
    <div className="flex items-center gap-1">
      {hotkeyAlternatives(shortcut.hotkey).map((alternative, index) => (
        <span key={alternative} className="flex items-center gap-1">
          {index > 0 && <span className="ui-text-xs text-faint">or</span>}
          {shortcut.prefix && (
            <>
              <Kbd>{formatHotkey(shortcut.prefix)}</Kbd>
              <span className="ui-text-xs text-faint">then</span>
            </>
          )}
          <Kbd>{formatHotkey(alternative)}</Kbd>
        </span>
      ))}
    </div>
  );
}

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
          <div key={section}>
            <h3 className="ui-text-sm text-muted mb-3 font-medium">{section}</h3>
            <div className="space-y-2">
              {SHORTCUT_ROWS.filter(([, shortcut]) => shortcut.section === section).map(
                ([id, shortcut]) => (
                  <div key={id} className="flex items-center justify-between py-1">
                    <span className="ui-text-sm text-body">{shortcut.description}</span>
                    <ShortcutKeys shortcut={shortcut} />
                  </div>
                )
              )}
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

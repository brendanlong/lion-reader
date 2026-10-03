/**
 * MarkAllReadButton Component
 *
 * Button (and Shift+A shortcut) that opens a confirmation dialog to mark all
 * entries as read. Encapsulates the button, dialog, and state management.
 */

"use client";

import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { CheckCircleIcon } from "@/components/ui/icons";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { isDialogOpen } from "@/components/ui/dialog";

interface MarkAllReadButtonProps {
  /** Description of what will be marked as read (e.g., "this feed", "all items") */
  contextDescription: string;
  /** Whether the mark all read mutation is in progress */
  isLoading: boolean;
  /**
   * Called when the user confirms marking all as read. Optional so the button
   * can render as a static control during SSR (see the demo's crawlable list
   * header), where no handler can cross the server/client boundary.
   */
  onConfirm?: () => void;
  /** Whether Shift+A opens the dialog */
  shortcutEnabled?: boolean;
}

export function MarkAllReadButton({
  contextDescription,
  isLoading,
  onConfirm,
  shortcutEnabled = false,
}: MarkAllReadButtonProps) {
  const [showDialog, setShowDialog] = useState(false);

  useHotkeys(
    "shift+a",
    (e) => {
      if (isDialogOpen()) return;
      e.preventDefault();
      setShowDialog(true);
    },
    { enabled: shortcutEnabled, enableOnFormTags: false },
    [shortcutEnabled]
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setShowDialog(true)}
        className="control-outline text-muted hover:bg-surface-muted hover:text-body inline-flex items-center justify-center rounded-md p-2 transition-colors"
        title="Mark all as read (Shift+A)"
        aria-label="Mark all as read"
      >
        <CheckCircleIcon className="h-5 w-5" />
        <span className="ui-text-sm ml-1.5 hidden sm:inline">Mark All Read</span>
      </button>

      <ConfirmDialog
        isOpen={showDialog}
        title="Mark all as read?"
        confirmLabel="Mark All Read"
        isLoading={isLoading}
        onConfirm={() => {
          onConfirm?.();
          setShowDialog(false);
        }}
        onCancel={() => setShowDialog(false)}
      >
        This will mark all unread entries in {contextDescription} as read.
      </ConfirmDialog>
    </>
  );
}

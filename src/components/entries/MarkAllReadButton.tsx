/**
 * MarkAllReadButton Component
 *
 * Button that opens a confirmation dialog to mark all entries as read.
 * Encapsulates the button, dialog, and state management.
 */

"use client";

import { useState } from "react";
import { CheckCircleIcon } from "@/components/ui/icon-button";
import { MarkAllReadDialog } from "@/components/feeds/MarkAllReadDialog";

interface MarkAllReadButtonProps {
  /** Description of what will be marked as read (e.g., "this feed", "all items") */
  contextDescription: string;
  /** Whether the mark all read mutation is in progress */
  isLoading: boolean;
  /** Called when the user confirms marking all as read */
  onConfirm: () => void;
}

export function MarkAllReadButton({
  contextDescription,
  isLoading,
  onConfirm,
}: MarkAllReadButtonProps) {
  const [showDialog, setShowDialog] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setShowDialog(true)}
        className="text-muted hover:bg-surface-muted hover:text-body inline-flex items-center justify-center rounded-md p-2 transition-colors"
        title="Mark all as read"
        aria-label="Mark all as read"
      >
        <CheckCircleIcon className="h-5 w-5" />
        <span className="ui-text-sm ml-1.5 hidden sm:inline">Mark All Read</span>
      </button>

      <MarkAllReadDialog
        isOpen={showDialog}
        contextDescription={contextDescription}
        isLoading={isLoading}
        onConfirm={() => {
          onConfirm();
          setShowDialog(false);
        }}
        onCancel={() => setShowDialog(false)}
      />
    </>
  );
}

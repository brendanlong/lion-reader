/**
 * FileIssueDialog Component
 *
 * Dialog for filing a GitHub issue about a broken feed. Requires the user
 * to confirm that the feed URL appears to be working and acknowledge that
 * the issue will be filed publicly on GitHub.
 */

"use client";

import { useState } from "react";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ExternalLinkIcon } from "@/components/ui/icon-button";

interface FileIssueDialogProps {
  isOpen: boolean;
  feedTitle: string;
  feedUrl: string | null;
  lastError: string | null;
  isLoading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// Wrapper unmounts the content when closed, resetting checkbox state on each open.
export function FileIssueDialog(props: FileIssueDialogProps) {
  if (!props.isOpen) return null;
  return <FileIssueDialogContent {...props} />;
}

function FileIssueDialogContent({
  isOpen,
  feedTitle,
  feedUrl,
  lastError,
  isLoading,
  onConfirm,
  onCancel,
}: FileIssueDialogProps) {
  const [feedWorking, setFeedWorking] = useState(false);
  const [publicAck, setPublicAck] = useState(false);

  const canSubmit = feedWorking && publicAck && !isLoading;

  return (
    <Dialog isOpen={isOpen} onClose={onCancel} title="File a Bug Report" size="lg">
      <DialogHeader>
        <DialogTitle>File a Bug Report</DialogTitle>
        <DialogDescription>
          Report this broken feed as an issue on the Lion Reader GitHub repository.
        </DialogDescription>
      </DialogHeader>

      <DialogBody className="space-y-4">
        {/* Feed info */}
        <div className="rounded-md border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800">
          <p className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-50">{feedTitle}</p>
          {feedUrl && (
            <a
              href={feedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ui-text-sm mt-1 inline-flex items-center gap-1 text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
            >
              {feedUrl}
              <ExternalLinkIcon className="h-3 w-3" />
            </a>
          )}
        </div>

        {/* Error details */}
        {lastError && (
          <div className="rounded-md bg-red-50 px-3 py-2 dark:bg-red-900/20">
            <p className="ui-text-sm font-medium text-red-700 dark:text-red-300">Error:</p>
            <p className="ui-text-sm mt-1 text-red-700 dark:text-red-300">{lastError}</p>
          </div>
        )}

        {/* Checkboxes */}
        <div className="space-y-3">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={feedWorking}
              onChange={(e) => setFeedWorking(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-50 dark:focus:ring-zinc-400"
            />
            <span className="ui-text-sm text-zinc-700 dark:text-zinc-300">
              I have verified that the feed URL above appears to be working and should be handled by
              Lion Reader
            </span>
          </label>

          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={publicAck}
              onChange={(e) => setPublicAck(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-500 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-50 dark:focus:ring-zinc-400"
            />
            <span className="ui-text-sm text-zinc-700 dark:text-zinc-300">
              I understand that this issue will be filed publicly at{" "}
              <a
                href="https://github.com/brendanlong/lion-reader/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
              >
                github.com/brendanlong/lion-reader/issues
              </a>
            </span>
          </label>
        </div>
      </DialogBody>

      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={isLoading}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onConfirm} loading={isLoading} disabled={!canSubmit}>
          File Issue
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

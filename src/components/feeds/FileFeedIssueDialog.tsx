/**
 * FileFeedIssueDialog Component
 *
 * Lets a user report a broken feed by opening a prefilled GitHub "new issue"
 * form in a new tab. We don't post the issue on the user's behalf — the user
 * reviews and submits it under their own GitHub account, which keeps the public
 * tracker free of spam and needs no server-side token.
 *
 * The user must confirm two things first:
 *  1. The feed link works and should be handled by Lion Reader.
 *  2. They understand issues are filed publicly.
 */

"use client";

import { useState } from "react";
import { Dialog, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TextLink } from "@/components/ui/text-link";
import { buildFeedIssueUrl, LION_READER_ISSUES_URL, type FeedIssueInput } from "@/lib/github-issue";

interface FileFeedIssueDialogProps {
  isOpen: boolean;
  /** The broken feed to file an issue about, or null when closed. */
  feed: (FeedIssueInput & { displayName: string }) | null;
  onClose: () => void;
}

export function FileFeedIssueDialog({ isOpen, feed, onClose }: FileFeedIssueDialogProps) {
  const [linkConfirmed, setLinkConfirmed] = useState(false);
  const [publicAcknowledged, setPublicAcknowledged] = useState(false);

  // Reset the checkboxes on every close path (cancel, escape, backdrop, submit)
  // so the dialog starts fresh the next time it opens for a (possibly different)
  // feed. Resetting here rather than in an effect keeps state updates in event
  // handlers (React guidance / react-hooks/set-state-in-effect).
  const handleClose = () => {
    setLinkConfirmed(false);
    setPublicAcknowledged(false);
    onClose();
  };

  if (!feed) return null;

  const canSubmit = linkConfirmed && publicAcknowledged;

  const handleFileIssue = () => {
    if (!canSubmit) return;
    window.open(buildFeedIssueUrl(feed), "_blank", "noopener,noreferrer");
    handleClose();
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={handleClose}
      title="Report a broken feed"
      titleId="file-issue-title"
    >
      <DialogTitle id="file-issue-title">Report a broken feed</DialogTitle>

      <DialogBody className="mt-4 space-y-4">
        <p className="ui-text-sm text-muted">
          If you think Lion Reader should be able to fetch this feed, you can open an issue on
          GitHub. We&apos;ll prefill the details — you review and submit it on GitHub.
        </p>

        {/* Feed details */}
        <div className="border-edge-strong bg-surface-subtle space-y-2 rounded-md border p-3">
          <div>
            <p className="ui-text-xs text-muted">Feed</p>
            <p className="text-body ui-text-sm font-medium break-words">{feed.displayName}</p>
          </div>
          {feed.url && (
            <div>
              <p className="ui-text-xs text-muted">URL</p>
              <TextLink href={feed.url} external className="ui-text-sm break-all">
                {feed.url}
              </TextLink>
            </div>
          )}
          {feed.lastError && (
            <div>
              <p className="ui-text-xs text-muted">Error</p>
              <p className="text-danger ui-text-sm break-words">{feed.lastError}</p>
            </div>
          )}
        </div>

        {/* Confirmations */}
        <div className="space-y-3">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={linkConfirmed}
              onChange={(e) => setLinkConfirmed(e.target.checked)}
              className="text-accent border-edge-input mt-0.5 h-4 w-4 rounded dark:bg-zinc-800"
            />
            <span className="ui-text-sm text-body">
              I&apos;ve confirmed the{" "}
              {feed.url ? (
                <TextLink href={feed.url} external>
                  feed link
                </TextLink>
              ) : (
                "feed link"
              )}{" "}
              works in a browser and believe Lion Reader should be able to fetch it.
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={publicAcknowledged}
              onChange={(e) => setPublicAcknowledged(e.target.checked)}
              className="text-accent border-edge-input mt-0.5 h-4 w-4 rounded dark:bg-zinc-800"
            />
            <span className="ui-text-sm text-body">
              I understand that issues are filed publicly at{" "}
              <TextLink href={LION_READER_ISSUES_URL} external>
                github.com/brendanlong/lion-reader/issues
              </TextLink>
              .
            </span>
          </label>
        </div>
      </DialogBody>

      <DialogFooter>
        <Button variant="secondary" onClick={handleClose}>
          Cancel
        </Button>
        <Button onClick={handleFileIssue} disabled={!canSubmit}>
          File Issue on GitHub
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

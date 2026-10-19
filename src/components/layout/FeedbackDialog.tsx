"use client";

import { Dialog, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TextLink } from "@/components/ui/text-link";
import { CONTACT_EMAIL } from "@/lib/contact";
import { LION_READER_ISSUES_URL } from "@/lib/github-issue";

interface FeedbackDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function FeedbackDialog({ isOpen, onClose }: FeedbackDialogProps) {
  return (
    <Dialog isOpen={isOpen} onClose={onClose} title="Send feedback" titleId="feedback-title">
      <DialogTitle id="feedback-title">Send feedback</DialogTitle>

      <DialogBody className="mt-4 space-y-4">
        <p className="ui-text-sm text-muted">
          We&apos;d love to hear what you think of Lion Reader — what works, what doesn&apos;t, and
          what you wish it did.
        </p>
        <div>
          <p className="ui-text-sm text-body font-medium">Report a bug or request a feature</p>
          <p className="ui-text-sm text-muted">
            Open an issue on{" "}
            <TextLink href={`${LION_READER_ISSUES_URL}/new`} external>
              GitHub
            </TextLink>
            . Issues are public.
          </p>
        </div>
        <div>
          <p className="ui-text-sm text-body font-medium">Anything else</p>
          <p className="ui-text-sm text-muted">
            Email <TextLink href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</TextLink>.
          </p>
        </div>
      </DialogBody>

      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

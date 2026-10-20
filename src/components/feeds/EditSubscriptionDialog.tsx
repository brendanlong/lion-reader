/**
 * EditSubscriptionDialog Component
 *
 * Dialog for editing subscription settings including custom title and tags.
 * Uses the reusable Dialog component.
 */

"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { applySubscriptionUpdate } from "@/lib/cache/operations";
import { useLocalTags } from "@/lib/hooks/useLocalTags";
import type { SubscriptionRow } from "@/lib/local-db/subscriptions";
import type { Tag } from "@/lib/types/tag";
import { Dialog, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { CheckIcon } from "@/components/ui/icons";
import { ColorDot } from "@/components/ui/color-picker";
import { ClientLink } from "@/components/ui/client-link";

// ============================================================================
// Types
// ============================================================================

interface EditSubscriptionFormProps {
  subscriptionId: string;
  currentTitle: string;
  isCollection: boolean;
  /** An email subscription's title falls back to its sender (#1846). */
  isEmail: boolean;
  currentCustomTitle: string | null;
  currentTagIds: string[];
  onClose: () => void;
}

interface EditSubscriptionDialogProps extends EditSubscriptionFormProps {
  isOpen: boolean;
}

// ============================================================================
// EditSubscriptionDialog Component (Wrapper)
// ============================================================================

/**
 * Wrapper component that conditionally renders the form.
 * This ensures the form is remounted when the dialog opens with new data.
 */
export function EditSubscriptionDialog({ isOpen, ...formProps }: EditSubscriptionDialogProps) {
  if (!isOpen) return null;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={formProps.onClose}
      title={formProps.isCollection ? "Edit Collection" : "Edit Subscription"}
      titleId="edit-subscription-title"
    >
      <EditSubscriptionForm key={formProps.subscriptionId} {...formProps} />
    </Dialog>
  );
}

// ============================================================================
// EditSubscriptionForm Component (Inner form)
// ============================================================================

function EditSubscriptionForm({
  subscriptionId,
  currentTitle,
  isCollection,
  isEmail,
  currentCustomTitle,
  currentTagIds,
  onClose,
}: EditSubscriptionFormProps) {
  // A collection's name is its custom title (#1846): edited directly, and
  // required. A feed's custom title is optional, falling back to the feed's.
  const [customTitle, setCustomTitle] = useState(
    isCollection ? currentTitle : (currentCustomTitle ?? "")
  );
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(currentTagIds);
  const [error, setError] = useState<string | null>(null);

  trpc.tags.list.useQuery();
  const tags: Tag[] = useLocalTags();

  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const applyResponse = (row: SubscriptionRow) => applySubscriptionUpdate(utils, queryClient, row);
  const updateMutation = trpc.subscriptions.update.useMutation({ onSuccess: applyResponse });
  const setTagsMutation = trpc.subscriptions.setTags.useMutation({ onSuccess: applyResponse });

  const handleSave = async () => {
    try {
      setError(null);

      // Update custom title if changed
      const newCustomTitle = customTitle.trim() || null;
      if (isCollection && !newCustomTitle) {
        setError("Collection name is required");
        return;
      }
      if (newCustomTitle !== (isCollection ? currentTitle : currentCustomTitle)) {
        await updateMutation.mutateAsync({
          id: subscriptionId,
          customTitle: newCustomTitle,
        });
      }

      // Update tags if changed
      const tagsChanged =
        selectedTagIds.length !== currentTagIds.length ||
        selectedTagIds.some((id) => !currentTagIds.includes(id));

      if (tagsChanged) {
        await setTagsMutation.mutateAsync({
          id: subscriptionId,
          tagIds: selectedTagIds,
        });
      }

      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save changes");
      toast.error("Failed to save subscription changes");
    }
  };

  const toggleTag = (tagId: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    );
  };

  const isPending = updateMutation.isPending || setTagsMutation.isPending;

  return (
    <>
      <DialogTitle id="edit-subscription-title">
        {isCollection ? "Edit Collection" : "Edit Subscription"}
      </DialogTitle>

      <DialogBody>
        <p className="ui-text-sm text-muted mb-4">
          {isCollection ? "Collection" : "Feed"}:{" "}
          <span className="text-body font-medium">{currentTitle}</span>
        </p>

        {error && (
          <Alert variant="error" className="mb-4">
            {error}
          </Alert>
        )}

        {/* Custom Title */}
        <div className="mb-4">
          <Input
            id="custom-title"
            label={isCollection ? "Name" : "Custom Title (optional)"}
            placeholder={
              isCollection
                ? undefined
                : isEmail
                  ? "Leave empty to use the sender"
                  : "Leave empty to use feed's default title"
            }
            value={customTitle}
            onChange={(e) => setCustomTitle(e.target.value)}
            disabled={isPending}
          />
        </div>

        {/* Tags */}
        <div className="mb-2">
          <label className="ui-text-sm text-body mb-2 block font-medium">Tags</label>
          {tags.length === 0 ? (
            <p className="ui-text-sm text-muted">
              No tags created yet. Create tags in{" "}
              <ClientLink href="/settings" className="text-body underline">
                Settings
              </ClientLink>
              .
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const isSelected = selectedTagIds.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    disabled={isPending}
                    className={`ui-text-sm flex items-center gap-1.5 rounded-full border px-3 py-1.5 transition-colors ${
                      isSelected
                        ? "border-primary-solid bg-primary-solid text-primary-solid-foreground"
                        : "text-body border-edge-input bg-surface hover:border-edge-emphasis hover:bg-surface-muted"
                    }`}
                  >
                    <ColorDot color={tag.color} size="sm" />
                    <span>{tag.name}</span>
                    {isSelected && <CheckIcon className="h-3.5 w-3.5" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </DialogBody>

      <DialogFooter>
        <Button variant="secondary" onClick={onClose} disabled={isPending}>
          Cancel
        </Button>
        <Button onClick={handleSave} loading={isPending}>
          Save Changes
        </Button>
      </DialogFooter>
    </>
  );
}

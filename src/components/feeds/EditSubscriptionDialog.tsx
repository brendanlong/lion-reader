/**
 * EditSubscriptionDialog Component
 *
 * Dialog for editing subscription settings including custom title and tags.
 */

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button, Input, Alert } from "@/components/ui";

// ============================================================================
// Types
// ============================================================================

interface EditSubscriptionDialogProps {
  isOpen: boolean;
  subscriptionId: string;
  currentTitle: string;
  currentCustomTitle: string | null;
  currentTagIds: string[];
  onClose: () => void;
}

interface Tag {
  id: string;
  name: string;
  color: string | null;
  feedCount: number;
  createdAt: Date;
}

interface EditSubscriptionFormProps {
  subscriptionId: string;
  currentTitle: string;
  currentCustomTitle: string | null;
  currentTagIds: string[];
  onClose: () => void;
}

// ============================================================================
// EditSubscriptionDialog Component (Wrapper)
// ============================================================================

/**
 * Wrapper component that conditionally renders the form.
 * This ensures the form is remounted when the dialog opens with new data.
 */
export function EditSubscriptionDialog({
  isOpen,
  subscriptionId,
  currentTitle,
  currentCustomTitle,
  currentTagIds,
  onClose,
}: EditSubscriptionDialogProps) {
  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/50 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="w-full max-w-md rounded-lg border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-subscription-title"
        >
          <EditSubscriptionForm
            key={subscriptionId}
            subscriptionId={subscriptionId}
            currentTitle={currentTitle}
            currentCustomTitle={currentCustomTitle}
            currentTagIds={currentTagIds}
            onClose={onClose}
          />
        </div>
      </div>
    </>
  );
}

// ============================================================================
// EditSubscriptionForm Component (Inner form)
// ============================================================================

function EditSubscriptionForm({
  subscriptionId,
  currentTitle,
  currentCustomTitle,
  currentTagIds,
  onClose,
}: EditSubscriptionFormProps) {
  // Initialize state with current values
  const [customTitle, setCustomTitle] = useState(currentCustomTitle ?? "");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(currentTagIds);
  const [error, setError] = useState<string | null>(null);

  // Fetch all tags
  const { data: tagsData } = trpc.tags.list.useQuery();
  const tags: Tag[] = tagsData?.items ?? [];

  // Mutations
  const updateMutation = trpc.subscriptions.update.useMutation();
  const setTagsMutation = trpc.subscriptions.setTags.useMutation();

  const handleSave = async () => {
    try {
      setError(null);

      // Update custom title if changed
      const newCustomTitle = customTitle.trim() || null;
      if (newCustomTitle !== currentCustomTitle) {
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
      <h2
        id="edit-subscription-title"
        className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50"
      >
        Edit Subscription
      </h2>

      <p className="ui-text-sm mb-4 text-zinc-500 dark:text-zinc-400">
        Feed: <span className="font-medium text-zinc-700 dark:text-zinc-300">{currentTitle}</span>
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
          label="Custom Title (optional)"
          placeholder="Leave empty to use feed's default title"
          value={customTitle}
          onChange={(e) => setCustomTitle(e.target.value)}
          disabled={isPending}
        />
      </div>

      {/* Tags */}
      <div className="mb-6">
        <label className="ui-text-sm mb-2 block font-medium text-zinc-700 dark:text-zinc-300">
          Tags
        </label>
        {tags.length === 0 ? (
          <p className="ui-text-sm text-zinc-500 dark:text-zinc-400">
            No tags created yet. Create tags in{" "}
            <a href="/settings" className="text-zinc-900 underline dark:text-zinc-50">
              Settings
            </a>
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
                      ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                      : "border-zinc-300 bg-white text-zinc-700 hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:bg-zinc-700"
                  }`}
                >
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: tag.color || "#6b7280" }}
                    aria-hidden="true"
                  />
                  <span>{tag.name}</span>
                  {isSelected && (
                    <svg
                      className="h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-3">
        <Button variant="secondary" onClick={onClose} disabled={isPending}>
          Cancel
        </Button>
        <Button onClick={handleSave} loading={isPending}>
          Save Changes
        </Button>
      </div>
    </>
  );
}

/**
 * Tag Management Component
 *
 * Provides UI for managing tags in settings.
 * Features:
 * - List all user's tags with colors and feed counts
 * - Create new tags with name and color
 * - Edit tag name and color inline
 * - Delete tags with confirmation
 */

"use client";

import { useState, Suspense } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { useFormMessages } from "@/lib/hooks";
import { type Tag, TAG_COLORS, DEFAULT_TAG_COLOR } from "@/lib/types";
import {
  Button,
  Input,
  ChevronDownIcon,
  EditIcon,
  TrashIcon,
  ColorPicker,
  ColorDot,
} from "@/components/ui";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { SettingsSection } from "./SettingsSection";

// ============================================================================
// Types
// ============================================================================

interface EditingTag {
  id: string;
  name: string;
  color: string | null;
}

// ============================================================================
// TagManagement Component
// ============================================================================

function TagManagementContent() {
  const { error, success, showError, showSuccess } = useFormMessages();

  // Use useSuspenseQuery to match the server-prefetched tags.list query,
  // preventing hydration mismatches between loading/loaded states
  const [tagsData] = trpc.tags.list.useSuspenseQuery();

  const tags = tagsData.items ?? [];

  return (
    <SettingsSection
      title="Tags"
      description="Create and manage tags to organize your feed subscriptions."
      error={error}
      success={success}
    >
      {/* Create new tag form */}
      <CreateTagForm onSuccess={showSuccess} onError={showError} />

      {/* Tag list */}
      <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
        {tags.length === 0 ? (
          <p className="ui-text-sm text-zinc-500 dark:text-zinc-400">
            No tags created yet. Create your first tag above.
          </p>
        ) : (
          <div className="space-y-3">
            {tags.map((tag) => (
              <TagItem key={tag.id} tag={tag} onSuccess={showSuccess} onError={showError} />
            ))}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

function TagManagementError() {
  return (
    <SettingsSection title="Tags" error="Failed to load tags">
      <div />
    </SettingsSection>
  );
}

function TagManagementSkeleton() {
  return (
    <SettingsSection title="Tags" isLoading skeletonRows={3}>
      <div />
    </SettingsSection>
  );
}

export function TagManagement() {
  return (
    <ErrorBoundary fallback={<TagManagementError />}>
      <Suspense fallback={<TagManagementSkeleton />}>
        <TagManagementContent />
      </Suspense>
    </ErrorBoundary>
  );
}

// ============================================================================
// CreateTagForm Component
// ============================================================================

interface CreateTagFormProps {
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

function CreateTagForm({ onSuccess, onError }: CreateTagFormProps) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(DEFAULT_TAG_COLOR);
  const [showColorPicker, setShowColorPicker] = useState(false);

  const utils = trpc.useUtils();

  const createMutation = trpc.tags.create.useMutation({
    onSuccess: () => {
      onSuccess("Tag created successfully");
      setName("");
      setColor(DEFAULT_TAG_COLOR);
      setShowColorPicker(false);
      utils.tags.list.invalidate();
    },
    onError: (err) => {
      onError(err.message || "Failed to create tag");
      toast.error("Failed to create tag");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      onError("Tag name is required");
      return;
    }

    createMutation.mutate({ name: name.trim(), color });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex-1">
        <Input
          id="new-tag-name"
          label="New tag"
          placeholder="Enter tag name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={createMutation.isPending}
        />
      </div>

      <div className="relative">
        <label className="ui-text-sm mb-1.5 block font-medium text-zinc-700 dark:text-zinc-300">
          Color
        </label>
        <button
          type="button"
          onClick={() => setShowColorPicker(!showColorPicker)}
          className="ui-text-sm flex h-[38px] items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          disabled={createMutation.isPending}
        >
          <ColorDot color={color} size="md" />
          <span className="text-zinc-700 dark:text-zinc-300">
            {TAG_COLORS.find((c) => c.value === color)?.name ?? "Select"}
          </span>
          <ChevronDownIcon className="h-4 w-4 text-zinc-400" />
        </button>

        {showColorPicker && (
          <ColorPicker
            selectedColor={color}
            onSelect={(c) => {
              setColor(c);
              setShowColorPicker(false);
            }}
            onClose={() => setShowColorPicker(false)}
          />
        )}
      </div>

      <Button type="submit" loading={createMutation.isPending}>
        Create tag
      </Button>
    </form>
  );
}

// ============================================================================
// TagItem Component
// ============================================================================

interface TagItemProps {
  tag: Tag;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
}

function TagItem({ tag, onSuccess, onError }: TagItemProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editingValues, setEditingValues] = useState<EditingTag | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);

  const utils = trpc.useUtils();

  const updateMutation = trpc.tags.update.useMutation({
    onSuccess: () => {
      onSuccess("Tag updated successfully");
      setIsEditing(false);
      setEditingValues(null);
      setShowColorPicker(false);
      utils.tags.list.invalidate();
    },
    onError: (err) => {
      onError(err.message || "Failed to update tag");
      toast.error("Failed to update tag");
    },
  });

  const deleteMutation = trpc.tags.delete.useMutation({
    onSuccess: () => {
      onSuccess("Tag deleted successfully");
      setShowDeleteConfirm(false);
      utils.tags.list.invalidate();
    },
    onError: (err) => {
      onError(err.message || "Failed to delete tag");
      toast.error("Failed to delete tag");
    },
  });

  const startEditing = () => {
    setEditingValues({
      id: tag.id,
      name: tag.name,
      color: tag.color,
    });
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setEditingValues(null);
    setShowColorPicker(false);
  };

  const saveEditing = () => {
    if (!editingValues) return;

    if (!editingValues.name.trim()) {
      onError("Tag name is required");
      return;
    }

    updateMutation.mutate({
      id: editingValues.id,
      name: editingValues.name.trim(),
      color: editingValues.color,
    });
  };

  const handleDelete = () => {
    deleteMutation.mutate({ id: tag.id });
  };

  if (showDeleteConfirm) {
    return (
      <div className="flex items-center justify-between rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
        <div className="flex items-center gap-3">
          <ColorDot color={tag.color} size="lg" />
          <div>
            <p className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-50">
              Delete &quot;{tag.name}&quot;?
            </p>
            <p className="ui-text-xs text-zinc-500 dark:text-zinc-400">
              This will remove the tag from all {tag.feedCount} subscription
              {tag.feedCount !== 1 ? "s" : ""}.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowDeleteConfirm(false)}
            disabled={deleteMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleDelete}
            loading={deleteMutation.isPending}
            className="bg-red-600 text-white hover:bg-red-700 focus:ring-red-600 dark:bg-red-600 dark:hover:bg-red-700"
          >
            Delete
          </Button>
        </div>
      </div>
    );
  }

  if (isEditing && editingValues) {
    return (
      <div className="flex flex-col gap-3 rounded-md border border-zinc-300 bg-zinc-50 p-4 sm:flex-row sm:items-center dark:border-zinc-600 dark:bg-zinc-800/50">
        <div className="flex flex-1 items-center gap-3">
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowColorPicker(!showColorPicker)}
              className="flex items-center justify-center rounded-md border border-zinc-300 p-2 transition-colors hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-700"
              disabled={updateMutation.isPending}
            >
              <ColorDot color={editingValues.color} size="lg" />
            </button>
            {showColorPicker && (
              <ColorPicker
                selectedColor={editingValues.color}
                onSelect={(c) => {
                  setEditingValues({ ...editingValues, color: c });
                  setShowColorPicker(false);
                }}
                onClose={() => setShowColorPicker(false)}
              />
            )}
          </div>
          <input
            type="text"
            value={editingValues.name}
            onChange={(e) => setEditingValues({ ...editingValues, name: e.target.value })}
            className="ui-text-sm flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-zinc-900 focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 focus:outline-none dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400 dark:focus:ring-zinc-400"
            disabled={updateMutation.isPending}
            autoFocus
          />
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={cancelEditing}
            disabled={updateMutation.isPending}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={saveEditing} loading={updateMutation.isPending}>
            Save
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/50">
      <div className="flex items-center gap-3">
        <ColorDot color={tag.color} size="lg" />
        <div>
          <p className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-50">{tag.name}</p>
          <p className="ui-text-xs text-zinc-500 dark:text-zinc-400">
            {tag.feedCount} feed{tag.feedCount !== 1 ? "s" : ""}
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={startEditing} title="Edit tag" className="px-2">
          <EditIcon className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowDeleteConfirm(true)}
          title="Delete tag"
          className="px-2 text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/20 dark:hover:text-red-300"
        >
          <TrashIcon className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

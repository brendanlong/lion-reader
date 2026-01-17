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

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button, Input, Alert } from "@/components/ui";

// ============================================================================
// Constants
// ============================================================================

/**
 * Predefined colors for tag selection
 */
const TAG_COLORS = [
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Yellow", value: "#eab308" },
  { name: "Lime", value: "#84cc16" },
  { name: "Green", value: "#22c55e" },
  { name: "Emerald", value: "#10b981" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Cyan", value: "#06b6d4" },
  { name: "Sky", value: "#0ea5e9" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Indigo", value: "#6366f1" },
  { name: "Violet", value: "#8b5cf6" },
  { name: "Purple", value: "#a855f7" },
  { name: "Fuchsia", value: "#d946ef" },
  { name: "Pink", value: "#ec4899" },
  { name: "Rose", value: "#f43f5e" },
  { name: "Gray", value: "#6b7280" },
] as const;

// ============================================================================
// Types
// ============================================================================

interface Tag {
  id: string;
  name: string;
  color: string | null;
  feedCount: number;
  createdAt: Date;
}

interface EditingTag {
  id: string;
  name: string;
  color: string | null;
}

// ============================================================================
// TagManagement Component
// ============================================================================

export function TagManagement() {
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Fetch tags
  const { data: tagsData, isLoading, error: queryError } = trpc.tags.list.useQuery();

  const tags = tagsData?.items ?? [];

  // Clear messages after timeout
  const showSuccess = useCallback((message: string) => {
    setSuccessMessage(message);
    setError(null);
    setTimeout(() => setSuccessMessage(null), 3000);
  }, []);

  const showError = useCallback((message: string) => {
    setError(message);
    setSuccessMessage(null);
  }, []);

  if (isLoading) {
    return (
      <section>
        <h2 className="ui-text-xl mb-4 font-semibold text-zinc-900 dark:text-zinc-50">Tags</h2>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="space-y-4">
            <div className="h-10 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-10 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-10 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
          </div>
        </div>
      </section>
    );
  }

  if (queryError) {
    return (
      <section>
        <h2 className="ui-text-xl mb-4 font-semibold text-zinc-900 dark:text-zinc-50">Tags</h2>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <Alert variant="error">Failed to load tags</Alert>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="ui-text-xl mb-4 font-semibold text-zinc-900 dark:text-zinc-50">Tags</h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="ui-text-base mb-4 text-zinc-500 dark:text-zinc-400">
          Create and manage tags to organize your feed subscriptions.
        </p>

        {error && (
          <Alert variant="error" className="mb-4">
            {error}
          </Alert>
        )}

        {successMessage && (
          <Alert variant="success" className="mb-4">
            {successMessage}
          </Alert>
        )}

        {/* Create new tag form */}
        <CreateTagForm onSuccess={showSuccess} onError={showError} />

        {/* Tag list */}
        <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
          {tags.length === 0 ? (
            <p className="ui-text-base text-zinc-500 dark:text-zinc-400">
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
      </div>
    </section>
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
  const [color, setColor] = useState<string | null>(TAG_COLORS[10].value); // Default to blue
  const [showColorPicker, setShowColorPicker] = useState(false);

  const utils = trpc.useUtils();

  const createMutation = trpc.tags.create.useMutation({
    onSuccess: () => {
      onSuccess("Tag created successfully");
      setName("");
      setColor(TAG_COLORS[10].value);
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
        <label className="ui-text-base mb-1.5 block font-medium text-zinc-700 dark:text-zinc-300">
          Color
        </label>
        <button
          type="button"
          onClick={() => setShowColorPicker(!showColorPicker)}
          className="ui-text-base flex h-[42px] items-center gap-2 rounded-md border border-zinc-300 bg-white px-3 py-2 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          disabled={createMutation.isPending}
        >
          <ColorDot color={color} size="md" />
          <span className="text-zinc-700 dark:text-zinc-300">
            {TAG_COLORS.find((c) => c.value === color)?.name ?? "Select"}
          </span>
          <svg
            className="h-4 w-4 text-zinc-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
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
            <p className="ui-text-base font-medium text-zinc-900 dark:text-zinc-50">
              Delete &quot;{tag.name}&quot;?
            </p>
            <p className="ui-text-sm text-zinc-500 dark:text-zinc-400">
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
            className="ui-text-base flex-1 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-zinc-900 focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 focus:outline-none dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400 dark:focus:ring-zinc-400"
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
          <p className="ui-text-base font-medium text-zinc-900 dark:text-zinc-50">{tag.name}</p>
          <p className="ui-text-sm text-zinc-500 dark:text-zinc-400">
            {tag.feedCount} feed{tag.feedCount !== 1 ? "s" : ""}
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={startEditing} title="Edit tag" className="px-2">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
            />
          </svg>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowDeleteConfirm(true)}
          title="Delete tag"
          className="px-2 text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/20 dark:hover:text-red-300"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// ColorDot Component
// ============================================================================

interface ColorDotProps {
  color: string | null;
  size?: "sm" | "md" | "lg";
}

function ColorDot({ color, size = "md" }: ColorDotProps) {
  const sizeClasses = {
    sm: "h-3 w-3",
    md: "h-4 w-4",
    lg: "h-5 w-5",
  };

  const displayColor = color ?? "#6b7280"; // Default to gray if no color

  return (
    <span
      className={`inline-block rounded-full ${sizeClasses[size]}`}
      style={{ backgroundColor: displayColor }}
      aria-hidden="true"
    />
  );
}

// ============================================================================
// ColorPicker Component
// ============================================================================

interface ColorPickerProps {
  selectedColor: string | null;
  onSelect: (color: string) => void;
  onClose: () => void;
}

function ColorPicker({ selectedColor, onSelect, onClose }: ColorPickerProps) {
  return (
    <>
      {/* Backdrop to close picker */}
      <div className="fixed inset-0 z-10" onClick={onClose} aria-hidden="true" />

      {/* Color picker dropdown */}
      <div className="absolute top-full left-0 z-20 mt-1 w-48 rounded-md border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-800">
        <div className="grid grid-cols-6 gap-1">
          {TAG_COLORS.map((colorOption) => (
            <button
              key={colorOption.value}
              type="button"
              onClick={() => onSelect(colorOption.value)}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition-transform hover:scale-110 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-1 focus:outline-none dark:focus:ring-zinc-400 ${
                selectedColor === colorOption.value
                  ? "ring-2 ring-zinc-900 ring-offset-1 dark:ring-zinc-400"
                  : ""
              }`}
              title={colorOption.name}
            >
              <span
                className="h-5 w-5 rounded-full"
                style={{ backgroundColor: colorOption.value }}
              />
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

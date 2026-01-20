/**
 * Tag Type Definition
 *
 * Centralized type for tags used across the application.
 * This type matches the structure returned by the tags.list API.
 */

/**
 * A tag used to organize feed subscriptions.
 */
export interface Tag {
  /**
   * Unique identifier for the tag (UUIDv7).
   */
  id: string;

  /**
   * Display name of the tag.
   */
  name: string;

  /**
   * Hex color code for the tag (e.g., "#3b82f6"), or null if no color set.
   */
  color: string | null;

  /**
   * Number of feed subscriptions using this tag.
   */
  feedCount: number;

  /**
   * When the tag was created.
   */
  createdAt: Date;
}

/**
 * Predefined colors available for tag selection.
 */
export const TAG_COLORS = [
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

/**
 * Default color for tags (Blue).
 */
export const DEFAULT_TAG_COLOR = TAG_COLORS[10].value;

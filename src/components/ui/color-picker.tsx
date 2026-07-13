/**
 * ColorPicker and ColorDot Components
 *
 * Reusable components for selecting and displaying colors.
 * Uses the predefined TAG_COLORS palette.
 */

import { TAG_COLORS } from "@/lib/types/tag";

// ============================================================================
// ColorDot Component
// ============================================================================

interface ColorDotProps {
  /**
   * The hex color to display. Defaults to gray (#6b7280) if null.
   */
  color: string | null;

  /**
   * Size variant of the dot.
   */
  size?: "sm" | "md" | "lg";
}

/**
 * A colored circle dot for displaying tag/category colors.
 */
export function ColorDot({ color, size = "md" }: ColorDotProps) {
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
  /**
   * Currently selected color.
   */
  selectedColor: string | null;

  /**
   * Callback when a color is selected.
   */
  onSelect: (color: string) => void;

  /**
   * Callback to close the picker (e.g., when clicking outside).
   */
  onClose: () => void;
}

/**
 * A dropdown color picker with predefined color options.
 * Should be positioned relative to a parent container.
 */
export function ColorPicker({ selectedColor, onSelect, onClose }: ColorPickerProps) {
  return (
    <>
      {/* Backdrop to close picker */}
      <div className="fixed inset-0 z-10" onClick={onClose} aria-hidden="true" />

      {/* Color picker dropdown */}
      <div className="border-edge-strong absolute top-full left-0 z-20 mt-1 w-48 rounded-md border bg-white p-2 shadow-lg dark:bg-zinc-800">
        <div className="grid grid-cols-6 gap-1">
          {TAG_COLORS.map((colorOption) => (
            <button
              key={colorOption.value}
              type="button"
              onClick={() => onSelect(colorOption.value)}
              className={`focus:ring-focus flex h-7 w-7 items-center justify-center rounded-md transition-transform hover:scale-110 focus:ring-2 focus:ring-offset-1 focus:outline-none ${
                selectedColor === colorOption.value
                  ? "ring-control-selected ring-2 ring-offset-1"
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

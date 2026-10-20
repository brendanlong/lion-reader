/**
 * Checkbox Component
 *
 * A native checkbox. It's themed entirely by the browser: `accent-color` (set
 * once on `body` in globals.css) colors the checked state and `color-scheme`
 * (set per theme) the unchecked box, so it takes no color classes — background,
 * border and text colors don't apply to a native checkbox. The exception is
 * e-paper, where the `checkbox` class redraws it (globals.css says why). Wrap
 * it in a `<label>` with its text so the whole label is the touch target.
 */

import type { ComponentProps } from "react";

type CheckboxProps = Omit<ComponentProps<"input">, "type">;

export function Checkbox({ className = "", ...props }: CheckboxProps) {
  return <input type="checkbox" className={`checkbox h-4 w-4 shrink-0 ${className}`} {...props} />;
}

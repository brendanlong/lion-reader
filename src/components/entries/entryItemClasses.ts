/**
 * Entry list CSS classes, shared by the list, its loading fallback, and its
 * skeleton.
 *
 * Density is styled with the `comfortable:`/`compact:` variants (the stored
 * setting on `<html>`; see src/app/globals.css), never a React prop: the list
 * is server-rendered without access to the stored setting, and switching it
 * after hydration would reflow the list.
 *
 * Selection is *not* styled here: the keyboard/`j`-`k` cursor and Tab focus are
 * unified onto the browser's single `:focus-visible` outline (the selected row is
 * the focused row), so there's no separate ring/border to keep in sync. This
 * avoids the double outline (border + ring) and the ring lingering after focus
 * moved elsewhere.
 */

/**
 * The list of entries: gapped bordered cards (comfortable), or a single divided
 * list (compact; the dividers survive e-paper via the darker `--edge`).
 */
export const ENTRY_LIST_CLASSES = "comfortable:space-y-3 compact:divide-edge compact:divide-y";

/**
 * Padding and card treatment of a row. Compact rows are borderless (the list
 * supplies `divide-edge` separators), so every border class is comfortable-only:
 * a border color would also recolor the divider.
 */
const ROW_LAYOUT_CLASSES =
  "comfortable:rounded-lg comfortable:border comfortable:p-3 comfortable:sm:p-4 compact:px-3 compact:py-2.5 compact:sm:px-4";

/**
 * The CSS classes for an entry row based on its read state.
 *
 * The unread/read *color* language is identical across densities — only the
 * padding and border treatment change.
 */
export function getItemClasses(read: boolean): string {
  const baseClasses = `group relative cursor-pointer transition-colors ${ROW_LAYOUT_CLASSES}`;

  if (read) {
    // Read entries recede into the page canvas: no fill of their own and a
    // faint hairline border, so they read as "already handled". They lift to a
    // surface fill on hover to signal they're still clickable (the surface
    // tokens already carry their own dark-mode values).
    // On e-paper every border is black, so "faint hairline" has to be said with
    // gray instead: the read card steps down to the theme's non-text gray level
    // while unread keeps the black edge.
    return `${baseClasses} bg-canvas hover:bg-surface active:bg-surface-muted comfortable:border-edge comfortable:epaper:border-fill-muted`;
  }

  // Unread entries stand out as raised surface cards with a distinctly stronger
  // border (the only card/canvas separation available on e-paper, where every
  // fill is white).
  return `${baseClasses} bg-surface hover:bg-surface-muted active:bg-zinc-100 dark:active:bg-zinc-700 comfortable:border-edge-input`;
}

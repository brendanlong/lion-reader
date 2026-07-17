/**
 * Entry list item CSS classes.
 *
 * Extracted from EntryListItem (a "use client" module) into this plain module so
 * it can be shared with server components — specifically the demo's crawlable SSR
 * list (DemoEntryListSSR), which must render byte-for-byte the same card styling
 * as the interactive EntryListItem so the hydration swap shows no flash. Next.js
 * forbids calling a function exported from a "use client" module during server
 * rendering, hence the split.
 */

import type { ListDensity } from "@/lib/appearance/settings";

/**
 * Get the appropriate CSS classes for the entry item based on read and density
 * state.
 *
 * Selection is *not* styled here: the keyboard/`j`-`k` cursor and Tab focus are
 * unified onto the browser's single `:focus-visible` outline (the selected row is
 * the focused row), so there's no separate ring/border to keep in sync — see
 * `getItemClasses`'s former selected branch, removed in favor of the focus
 * outline. This avoids the double outline (border + ring) and the ring lingering
 * after focus moved elsewhere.
 *
 * The unread/read *color* language is identical across densities — only the
 * padding and border treatment change. In "compact" mode items are borderless
 * rows in a single `divide-edge` list (see EntryList), so the per-card borders
 * (including the e-paper `border-zinc-500` fallback) are dropped; the darker
 * e-paper divider handles row separation instead.
 */
export function getItemClasses(read: boolean, density: ListDensity = "comfortable"): string {
  const compact = density === "compact";
  const baseClasses = compact
    ? "group relative cursor-pointer px-3 py-2.5 transition-colors sm:px-4"
    : "group relative cursor-pointer rounded-lg border p-3 transition-colors sm:p-4";

  if (read) {
    // Read entries recede into the page canvas: no fill of their own and a
    // faint hairline border, so they read as "already handled". They lift to a
    // surface fill on hover to signal they're still clickable (the surface
    // tokens already carry their own dark-mode values).
    const readClasses = `${baseClasses} bg-canvas hover:bg-surface active:bg-surface-muted`;
    return compact ? readClasses : `${readClasses} border-edge`;
  }

  // Unread entries stand out as raised surface cards with a distinctly stronger
  // border (the only card/canvas separation available on e-paper, where every
  // fill is white).
  const unreadClasses = `${baseClasses} bg-surface hover:bg-surface-muted active:bg-zinc-100 dark:active:bg-zinc-700`;
  return compact ? unreadClasses : `${unreadClasses} border-edge-input epaper:border-zinc-500`;
}

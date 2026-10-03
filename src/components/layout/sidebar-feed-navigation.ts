/**
 * Shift+J / Shift+K: move to the next/previous tag or subscription in the
 * sidebar, in the order it shows them.
 */

import { isDialogOpen } from "@/components/ui/dialog";

/** Marks the sidebar list whose links Shift+J/Shift+K step through. */
export const SIDEBAR_FEEDS_ATTRIBUTE = "data-sidebar-feeds";

const isCurrent = (link: HTMLAnchorElement) => link.getAttribute("aria-current") === "page";

/**
 * Follows the sidebar link after (1) or before (-1) the current one, or the
 * first/last link when no tag or subscription is current.
 *
 * It walks the rendered links rather than the tag/subscription data so it
 * matches exactly what the reader sees: collapsed tags are skipped over, the
 * unread-only filter applies, and per-tag pages not yet loaded aren't
 * reachable. The sidebar keeps the current item listed (and marks only the
 * chosen copy of a multi-tag subscription; see useSidebarSelection), so
 * there's always a current link to step from.
 */
export function goToSidebarFeed(direction: 1 | -1): void {
  if (isDialogOpen()) return;
  const links = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(`[${SIDEBAR_FEEDS_ATTRIBUTE}] a[href]`)
  );
  const currentIndex = links.findIndex(isCurrent);
  const target =
    currentIndex === -1
      ? links[direction === 1 ? 0 : links.length - 1]
      : links[currentIndex + direction];
  if (!target) return;

  // Dispatch a plain click so the link's own handler runs, exactly as for a
  // mouse click (it records which copy was chosen). Not `target.click()`: that
  // may carry the held Shift, which ClientLink leaves to the browser (new
  // window).
  target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  target.scrollIntoView({ block: "nearest" });
}

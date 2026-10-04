/**
 * Which sidebar section lists a subscription, and in what order.
 */

/** Section key for subscriptions without tags. */
export const UNCATEGORIZED_SECTION = "uncategorized";

/** Whether a subscription with these tags is listed in `section` of the sidebar. */
export function isInSidebarSection(
  subscription: { tags: ReadonlyArray<{ id: string }> },
  section: string
): boolean {
  return section === UNCATEGORIZED_SECTION
    ? subscription.tags.length === 0
    : subscription.tags.some((tag) => tag.id === section);
}

/** The order of a section's rows: `subscriptions.list` sorts by title, then id. */
export function compareSidebarOrder(
  a: { id: string; title: string | null },
  b: { id: string; title: string | null }
): number {
  return (a.title ?? "").localeCompare(b.title ?? "") || (a.id > b.id ? 1 : a.id < b.id ? -1 : 0);
}

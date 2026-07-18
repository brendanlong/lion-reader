/**
 * DemoListHeader Component
 *
 * The entry-list header (title + Mark All Read / Sort / Show-unread controls),
 * shared by BOTH the SSR list (DemoEntryListSSR, a server component) and the
 * interactive client list (DemoRouter). Rendering the identical markup in both
 * is what keeps the action buttons from popping in — and the whole list from
 * shifting down ~a pixel — when DemoLayoutContent swaps the SSR HTML for the
 * client router on hydration.
 *
 * This component is intentionally NOT a "use client" module: it composes the
 * shared button components (which are themselves client components) but adds no
 * client-only APIs of its own, so a server component can render it as long as
 * it passes no handlers. The handlers are optional — the SSR path omits them
 * (the buttons render inert, then are replaced by the interactive router on
 * hydration), while DemoRouter passes the real DemoStateContext actions.
 */

import { MarkAllReadButton } from "@/components/entries/MarkAllReadButton";
import { SortToggle } from "@/components/entries/SortToggle";
import { UnreadToggle } from "@/components/entries/UnreadToggle";

interface DemoListHeaderProps {
  /** Page title (e.g. "All Features", a subscription/tag name, "Highlights"). */
  title: string;
  /**
   * Whether to show the action buttons. False for Highlights (mirroring
   * DemoRouter, which hides them there) so the SSR and client headers match.
   */
  showActions: boolean;
  /** Current sort order (defaults to "newest" on the SSR path). */
  sortOrder: "newest" | "oldest";
  /** Whether only unread entries are shown (defaults to false on the SSR path). */
  showUnreadOnly: boolean;
  /** Description used in the mark-all-read confirmation dialog. */
  markAllReadDescription: string;
  /** Confirm handler for mark-all-read (omitted during SSR). */
  onMarkAllRead?: () => void;
  /** Sort-order toggle handler (omitted during SSR). */
  onToggleSort?: () => void;
  /** Unread-only toggle handler (omitted during SSR). */
  onToggleUnread?: () => void;
}

export function DemoListHeader({
  title,
  showActions,
  sortOrder,
  showUnreadOnly,
  markAllReadDescription,
  onMarkAllRead,
  onToggleSort,
  onToggleUnread,
}: DemoListHeaderProps) {
  return (
    <div className="mb-4 flex items-center justify-between sm:mb-6">
      <h1 className="ui-text-xl sm:ui-text-2xl text-body font-bold">{title}</h1>
      {showActions && (
        <div className="flex gap-2">
          <MarkAllReadButton
            contextDescription={markAllReadDescription}
            isLoading={false}
            onConfirm={onMarkAllRead}
          />
          <SortToggle sortOrder={sortOrder} onToggle={onToggleSort} />
          <UnreadToggle showUnreadOnly={showUnreadOnly} onToggle={onToggleUnread} />
        </div>
      )}
    </div>
  );
}

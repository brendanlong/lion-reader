/**
 * SubscriptionItem Component
 *
 * A single subscription item in the sidebar navigation.
 * Shows the subscription title, unread count, and action buttons on hover.
 */

"use client";

import { IconButton, EditIcon, CloseIcon } from "@/components/ui/icon-button";
import { ClientLink } from "@/components/ui/client-link";

// ============================================================================
// Types
// ============================================================================

export interface SubscriptionItemProps {
  subscription: {
    id: string;
    title: string | null;
    unreadCount: number;
  };
  isActive: boolean;
  /** Called with the link href when the subscription link is clicked */
  onClose: (href: string) => void;
  onEdit: () => void;
  onUnsubscribe: () => void;
  /** Optional href override (e.g., for demo page query-param navigation) */
  href?: string;
  /** Called on mousedown with the link href (e.g., to prefetch data) */
  onPrefetch?: (href: string) => void;
}

// ============================================================================
// SubscriptionItem Component
// ============================================================================

export function SubscriptionItem({
  subscription,
  isActive,
  onClose,
  onEdit,
  onUnsubscribe,
  href,
  onPrefetch,
}: SubscriptionItemProps) {
  const displayTitle = subscription.title || "Untitled Feed";
  const subHref = href ?? `/subscription/${subscription.id}`;

  return (
    <li className="group relative flex items-center">
      <ClientLink
        href={subHref}
        onNavigate={onClose}
        onPrefetch={onPrefetch}
        className={`ui-text-sm flex min-h-[44px] min-w-0 flex-1 items-center justify-between rounded-md px-3 py-2 transition-colors ${
          isActive ? "bg-surface-muted text-body" : "text-body hover:bg-surface-muted"
        }`}
      >
        {/* pr-8 keeps long titles clear of the desktop hover-overlay buttons;
            on hover-less devices the buttons are in-flow, so reclaim the space */}
        <span className="hover-none:pr-2 truncate pr-8">{displayTitle}</span>
        {subscription.unreadCount > 0 && (
          <span className="ui-text-xs text-muted shrink-0 tabular-nums group-hover:hidden">
            ({subscription.unreadCount})
          </span>
        )}
      </ClientLink>

      {/* Action buttons — revealed on hover (and untappable while hidden, so an
          invisible button never swallows a click); on hover-less devices they
          sit in-flow after the unread count, always visible. */}
      <div className="hover-none:static hover-none:translate-y-0 hover-none:pr-1 hover-none:opacity-100 hover-none:pointer-events-auto pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
        <IconButton
          icon={<EditIcon />}
          aria-label={`Edit ${displayTitle}`}
          title="Edit subscription"
          size="sm"
          variant="subtle"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        />
        <IconButton
          icon={<CloseIcon className="h-3.5 w-3.5" />}
          aria-label={`Unsubscribe from ${displayTitle}`}
          title="Unsubscribe"
          size="sm"
          variant="subtle"
          onClick={(e) => {
            e.stopPropagation();
            onUnsubscribe();
          }}
        />
      </div>
    </li>
  );
}

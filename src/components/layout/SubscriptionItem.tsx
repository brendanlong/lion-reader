/**
 * SubscriptionItem Component
 *
 * A single subscription item in the sidebar navigation.
 * Shows the subscription title, unread count, and action buttons on hover.
 */

"use client";

import { IconButton, EditIcon, CloseIcon, ClientLink } from "@/components/ui";

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
  onClose: () => void;
  onEdit: () => void;
  onUnsubscribe: () => void;
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
}: SubscriptionItemProps) {
  const displayTitle = subscription.title || "Untitled Feed";
  const subHref = `/subscription/${subscription.id}`;

  return (
    <li className="group relative">
      <ClientLink
        href={subHref}
        onNavigate={onClose}
        className={`ui-text-sm flex min-h-[44px] items-center justify-between rounded-md px-3 py-2 transition-colors ${
          isActive
            ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
            : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
        }`}
      >
        <span className="truncate pr-8">{displayTitle}</span>
        {subscription.unreadCount > 0 && (
          <span className="ui-text-xs shrink-0 text-zinc-500 group-hover:hidden dark:text-zinc-400">
            ({subscription.unreadCount})
          </span>
        )}
      </ClientLink>

      {/* Action buttons - visible on hover/touch */}
      <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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

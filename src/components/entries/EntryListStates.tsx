/**
 * Shared state components for article lists.
 *
 * Provides the empty state, the "loading more" indicator, and the end-of-list
 * marker used by EntryList for all entry types. Load errors never reach here:
 * the container query uses `throwOnError`, so they surface via the
 * surrounding ErrorBoundary.
 */

"use client";

import { type ReactNode } from "react";
import { SpinnerIcon, DefaultEmptyIcon } from "@/components/ui/icons";

/**
 * Props for the EntryListEmpty component.
 */
export interface EntryListEmptyProps {
  /** Message to display */
  message: string;
  /** Optional custom icon */
  icon?: ReactNode;
}

/**
 * Empty state component for entry lists.
 */
export function EntryListEmpty({ message, icon }: EntryListEmptyProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      {icon ?? <DefaultEmptyIcon className="text-faint mb-4 h-12 w-12" />}
      <p className="ui-text-sm text-muted">{message}</p>
    </div>
  );
}

/**
 * Loading more indicator shown at bottom during pagination.
 */
export function EntryListLoadingMore({ label = "Loading more..." }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-4" role="status" aria-label={label}>
      <SpinnerIcon className="text-faint h-5 w-5" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

/**
 * End of list indicator.
 */
export function EntryListEnd({ message = "No more entries" }: { message?: string }) {
  return <p className="ui-text-sm text-faint py-4 text-center">{message}</p>;
}

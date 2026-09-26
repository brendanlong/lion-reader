/**
 * Shared state components for article lists.
 *
 * Provides the empty state, the "loading more" indicator, and the end-of-list
 * marker used by EntryList for all entry types. Load errors never reach here:
 * the container query uses `throwOnError`, so they surface via the
 * surrounding ErrorBoundary.
 */

"use client";

import { SpinnerIcon, DefaultEmptyIcon } from "@/components/ui/icons";

/**
 * Empty state component for entry lists.
 */
export function EntryListEmpty({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <DefaultEmptyIcon className="text-faint mb-4 h-12 w-12" />
      <p className="ui-text-sm text-muted">{message}</p>
    </div>
  );
}

/**
 * Loading more indicator shown at bottom during pagination.
 */
export function EntryListLoadingMore({ label }: { label: string }) {
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
export function EntryListEnd() {
  return <p className="ui-text-sm text-faint py-4 text-center">No more entries</p>;
}

/**
 * Shared state components for article lists.
 *
 * Provides empty state, error state, and loading indicator
 * components used by EntryList for all entry types.
 */

"use client";

import { type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertIcon, SpinnerIcon, DefaultEmptyIcon } from "@/components/ui/icon-button";

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
      {icon ?? <DefaultEmptyIcon className="mb-4 h-12 w-12 text-zinc-400 dark:text-zinc-500" />}
      <p className="ui-text-sm text-zinc-500 dark:text-zinc-400">{message}</p>
    </div>
  );
}

/**
 * Props for the EntryListError component.
 */
export interface EntryListErrorProps {
  /** Error message to display */
  message: string;
  /** Callback when retry button is clicked */
  onRetry: () => void;
}

/**
 * Error state component for entry lists.
 */
export function EntryListError({ message, onRetry }: EntryListErrorProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <AlertIcon className="mb-4 h-12 w-12 text-red-400 dark:text-red-500" />
      <p className="ui-text-sm mb-4 text-zinc-500 dark:text-zinc-400">{message}</p>
      <Button onClick={onRetry}>Try again</Button>
    </div>
  );
}

/**
 * Loading more indicator shown at bottom during pagination.
 */
export function EntryListLoadingMore({ label = "Loading more..." }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-4" role="status" aria-label={label}>
      <SpinnerIcon className="h-5 w-5 text-zinc-500" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

/**
 * End of list indicator.
 */
export function EntryListEnd({ message = "No more entries" }: { message?: string }) {
  return <p className="ui-text-sm py-4 text-center text-zinc-400 dark:text-zinc-500">{message}</p>;
}

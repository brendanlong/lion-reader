/**
 * NotFoundCard Component
 *
 * Displays a centered error card for when a resource is not found.
 * Used by subscription and tag pages when the requested entity doesn't exist.
 */

import { AlertIcon } from "./icon-button";

interface NotFoundCardProps {
  /** The title of the error (e.g., "Subscription not found") */
  title: string;
  /** The message explaining what happened */
  message: string;
}

export function NotFoundCard({ title, message }: NotFoundCardProps) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="rounded-lg border border-zinc-200 bg-white p-6 text-center sm:p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/20">
          <AlertIcon className="h-6 w-6 text-red-500 dark:text-red-400" />
        </div>
        <h2 className="ui-text-lg mb-2 font-medium text-zinc-900 dark:text-zinc-50">{title}</h2>
        <p className="ui-text-sm text-zinc-600 dark:text-zinc-400">{message}</p>
      </div>
    </div>
  );
}

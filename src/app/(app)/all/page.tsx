/**
 * All Entries Page
 *
 * Displays all entries from subscribed feeds in a unified timeline.
 * This is the main view after logging in.
 */

export default function AllEntriesPage() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-50">All Items</h1>
      </div>

      {/* Placeholder for entry list - will be implemented in Phase 5 */}
      <div className="rounded-lg border border-zinc-200 bg-white p-8 text-center dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
          <svg
            className="h-6 w-6 text-zinc-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z"
            />
          </svg>
        </div>
        <h2 className="mb-2 text-lg font-medium text-zinc-900 dark:text-zinc-50">
          Entry list coming soon
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          The entry display feature is being implemented in Phase 5.
          <br />
          For now, you can subscribe to feeds using the sidebar.
        </p>
      </div>
    </div>
  );
}

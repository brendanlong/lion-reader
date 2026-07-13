/**
 * Entry Content States
 *
 * Loading skeleton and error state components for entry content.
 */

/**
 * Loading skeleton for entry content.
 * Used when there's no cached data available.
 */
export function EntryContentSkeleton() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:py-8">
      {/* Back button placeholder */}
      <div className="bg-fill-muted mb-4 h-10 w-28 animate-pulse rounded sm:mb-6" />

      {/* Header section */}
      <header className="mb-6 sm:mb-8">
        {/* Title row with vote controls placeholder */}
        <div className="mb-4 flex gap-4 sm:mb-6">
          <div className="min-w-0 flex-1">
            {/* Title placeholder */}
            <div className="bg-fill-muted mb-2 h-8 w-3/4 animate-pulse rounded" />
            <div className="bg-fill-muted mb-4 h-8 w-1/2 animate-pulse rounded" />

            {/* Meta row placeholder */}
            <div className="flex items-center gap-4">
              <div className="bg-fill-muted h-4 w-24 animate-pulse rounded" />
              <div className="bg-fill-muted h-4 w-32 animate-pulse rounded" />
            </div>
          </div>

          {/* Vote controls placeholder */}
          <div className="shrink-0">
            <div className="bg-fill-muted flex h-24 w-10 animate-pulse flex-col items-center justify-center rounded" />
          </div>
        </div>

        {/* Action buttons placeholder */}
        <div className="flex gap-2 sm:gap-3">
          <div className="bg-fill-muted h-10 w-24 animate-pulse rounded" />
          <div className="bg-fill-muted h-10 w-24 animate-pulse rounded" />
          <div className="bg-fill-muted h-10 w-28 animate-pulse rounded" />
          <div className="bg-fill-muted h-10 w-20 animate-pulse rounded" />
        </div>
      </header>

      {/* Divider - always show (not animated) */}
      <hr className="border-edge-strong mb-6 sm:mb-8" />

      {/* Content placeholders */}
      <ContentSkeleton />
    </div>
  );
}

/**
 * Skeleton for the content area only (used during progressive loading).
 * Shows a loading skeleton in the content area while header is already visible.
 */
export function ContentSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="bg-fill-muted h-4 w-full rounded" />
      <div className="bg-fill-muted h-4 w-full rounded" />
      <div className="bg-fill-muted h-4 w-5/6 rounded" />
      <div className="bg-fill-muted h-4 w-full rounded" />
      <div className="bg-fill-muted h-4 w-3/4 rounded" />
      <div className="bg-fill-muted h-4 w-full rounded" />
      <div className="bg-fill-muted h-4 w-4/5 rounded" />
    </div>
  );
}

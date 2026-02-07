/**
 * DemoListSkeleton Component
 *
 * Skeleton placeholder for demo list views, shared by DemoRouter (Suspense fallback)
 * and DemoLayoutContent (SSR fallback before hydration).
 */

export function DemoListSkeleton() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 sm:mb-6">
        <div className="h-8 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
        ))}
      </div>
    </div>
  );
}

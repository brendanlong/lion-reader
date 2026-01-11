/**
 * Saved Articles Page
 *
 * Server component that prefetches data for the saved articles view.
 * The actual UI is rendered by the client component.
 */

import { dehydrate } from "@tanstack/react-query";
import { createServerQueryClient, createServerCaller } from "@/lib/trpc/server";
import { HydrationBoundary } from "@/lib/trpc/provider";
import { SavedArticlesClient } from "./client";

export default async function SavedArticlesPage() {
  const queryClient = createServerQueryClient();
  const { caller, session } = await createServerCaller();

  if (session) {
    // Prefetch saved articles list (infinite query)
    // Uses default view preferences: unreadOnly=true, sortOrder="newest"
    await queryClient.prefetchInfiniteQuery({
      queryKey: [
        ["entries", "list"],
        {
          input: { type: "saved", unreadOnly: true, sortOrder: "newest", limit: 20 },
          type: "infinite",
        },
      ],
      queryFn: () =>
        caller.entries.list({ type: "saved", unreadOnly: true, sortOrder: "newest", limit: 20 }),
      initialPageParam: undefined,
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <SavedArticlesClient />
    </HydrationBoundary>
  );
}

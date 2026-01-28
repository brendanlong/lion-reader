/**
 * Single Subscription Content Component
 *
 * Client component that displays entries from a specific subscription.
 * Used by the page.tsx server component which handles SSR prefetching.
 */

"use client";

import { Suspense, useCallback } from "react";
import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { EntryPageLayout } from "@/components/entries";
import { NotFoundCard } from "@/components/ui";
import { useEntryPage } from "@/lib/hooks";
import { trpc } from "@/lib/trpc/client";
import { findCachedSubscription } from "@/lib/cache";

function SingleSubscriptionContentInner() {
  const params = useParams<{ id: string }>();
  const subscriptionId = params.id;
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  const page = useEntryPage({
    viewId: "subscription",
    viewScopeId: subscriptionId,
    filters: { subscriptionId },
  });

  // Use cached subscription data as placeholder so the title renders instantly.
  // Searches both the unparameterized list (entry pages) and per-tag infinite
  // queries (sidebar), since the data may be in either cache.
  const getPlaceholderData = useCallback(() => {
    return findCachedSubscription(utils, queryClient, subscriptionId);
  }, [utils, queryClient, subscriptionId]);

  // Fetch the specific subscription directly instead of searching through
  // the paginated subscriptions.list results, which may not include it
  const subscriptionQuery = trpc.subscriptions.get.useQuery(
    { id: subscriptionId },
    { placeholderData: getPlaceholderData }
  );
  const subscription = subscriptionQuery.data;

  // Derive feed title from subscription (if available)
  const feedTitle = subscription
    ? (subscription.title ?? subscription.originalTitle ?? "Untitled Feed")
    : null;

  // Show error if subscription query completed but subscription not found
  if (!subscriptionQuery.isLoading && !subscription) {
    return (
      <NotFoundCard
        title="Subscription not found"
        message="The subscription you're looking for doesn't exist or you're not subscribed to it."
      />
    );
  }

  return (
    <EntryPageLayout
      page={page}
      title={feedTitle}
      emptyMessageUnread="No unread entries in this subscription. Toggle to show all items."
      emptyMessageAll="No entries in this subscription yet. Entries will appear here once the feed is fetched."
      markAllReadDescription="this subscription"
      markAllReadOptions={{ subscriptionId }}
    />
  );
}

export function SingleSubscriptionContent() {
  return (
    <Suspense>
      <SingleSubscriptionContentInner />
    </Suspense>
  );
}

/**
 * Single Subscription Content Component
 *
 * Client component that displays entries from a specific subscription.
 * Used by the page.tsx server component which handles SSR prefetching.
 */

"use client";

import { Suspense, useMemo } from "react";
import { useParams } from "next/navigation";
import { EntryPageLayout } from "@/components/entries";
import { NotFoundCard } from "@/components/ui";
import { useEntryPage } from "@/lib/hooks";

function SingleSubscriptionContentInner() {
  const params = useParams<{ id: string }>();
  const subscriptionId = params.id;

  const page = useEntryPage({
    viewId: "subscription",
    viewScopeId: subscriptionId,
    filters: { subscriptionId },
  });

  // Find the subscription
  const subscription = useMemo(
    () => page.subscriptions?.items.find((item) => item.id === subscriptionId),
    [page.subscriptions, subscriptionId]
  );

  // Derive feed title from subscription (if available)
  const feedTitle = subscription
    ? ((subscription as { title?: string }).title ??
      (subscription as { originalTitle?: string }).originalTitle ??
      "Untitled Feed")
    : null;

  // Show error if subscriptions loaded but subscription not found
  if (!page.subscriptionsLoading && !subscription) {
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

/**
 * EntryListTitle Component
 *
 * Reactively reads subscription/tag titles from TanStack DB collections.
 * Uses useLiveQuery with findOne() so the title re-renders automatically
 * when the data appears in the collection (e.g., after SSR prefetch
 * hydrates or a validation query populates it).
 *
 * Loaded via dynamic() with ssr: false because useLiveQuery uses
 * useSyncExternalStore without getServerSnapshot.
 */

"use client";

import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { TitleSkeleton, TitleText } from "./EntryPageLayout";
import { useCollections } from "@/lib/collections/context";

interface EntryListTitleProps {
  routeInfo: {
    title: string | null;
    subscriptionId?: string;
    tagId?: string;
  };
}

export function EntryListTitle({ routeInfo }: EntryListTitleProps) {
  const { subscriptions, tags } = useCollections();

  // Reactive lookup — re-renders when the subscription appears in the collection
  const { data: subscription } = useLiveQuery(
    (q) =>
      q
        .from({ s: subscriptions })
        .where(({ s }) => eq(s.id, routeInfo.subscriptionId ?? ""))
        .findOne(),
    [routeInfo.subscriptionId]
  );

  // Reactive lookup — re-renders when the tag appears in the collection
  const { data: tag } = useLiveQuery(
    (q) =>
      q
        .from({ t: tags })
        .where(({ t }) => eq(t.id, routeInfo.tagId ?? ""))
        .findOne(),
    [routeInfo.tagId]
  );

  // Static title
  if (routeInfo.title !== null) {
    return <TitleText>{routeInfo.title}</TitleText>;
  }

  // Subscription title
  if (routeInfo.subscriptionId) {
    if (subscription) {
      return (
        <TitleText>{subscription.title ?? subscription.originalTitle ?? "Untitled Feed"}</TitleText>
      );
    }
    return <TitleSkeleton />;
  }

  // Tag title
  if (routeInfo.tagId) {
    if (tag) {
      return <TitleText>{tag.name}</TitleText>;
    }
    return <TitleSkeleton />;
  }

  return <TitleText>All Items</TitleText>;
}

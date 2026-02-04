/**
 * Tag Entries Content Component
 *
 * Client component that displays entries from a specific tag or uncategorized feeds.
 * Used by the page.tsx server component which handles SSR prefetching.
 *
 * Uses Suspense with a smart fallback that shows cached entries while loading.
 */

"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { EntryPageLayout, EntryListFallback } from "@/components/entries";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { NotFoundCard } from "@/components/ui";
import { useEntryPage } from "@/lib/hooks";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";
import { trpc } from "@/lib/trpc/client";
import {
  UncategorizedEntriesContentInner,
  UncategorizedEntriesFallback,
} from "@/app/(app)/uncategorized/UncategorizedEntriesContent";

/**
 * Content for regular tag entries.
 */
function TagContent({ tagId }: { tagId: string }) {
  const page = useEntryPage({
    viewId: "tag",
    viewScopeId: tagId,
    filters: { tagId },
  });

  // Fetch tag info (should be cached from layout prefetch)
  const tagsQuery = trpc.tags.list.useQuery();
  const tag = tagsQuery.data?.items.find((t) => t.id === tagId);
  const tagName = tag?.name ?? null;

  // Show error if tags loaded but tag not found
  if (!tagsQuery.isLoading && !tag) {
    return (
      <NotFoundCard title="Tag not found" message="The tag you're looking for doesn't exist." />
    );
  }

  return (
    <EntryPageLayout
      page={page}
      title={tagName}
      emptyMessageUnread={`No unread entries from feeds tagged with "${tagName ?? "this tag"}". Toggle to show all items.`}
      emptyMessageAll={`No entries from feeds tagged with "${tagName ?? "this tag"}" yet.`}
      markAllReadDescription={tagName ? `the "${tagName}" tag` : "this tag"}
      markAllReadOptions={{ tagId }}
    />
  );
}

function TagEntriesContentInner() {
  const params = useParams<{ tagId: string }>();
  const tagId = params.tagId;
  const isUncategorized = tagId === "uncategorized";

  if (isUncategorized) {
    return <UncategorizedEntriesContentInner />;
  }

  return <TagContent tagId={tagId} />;
}

function TagEntriesFallback() {
  const params = useParams<{ tagId: string }>();
  const tagId = params.tagId;
  const isUncategorized = tagId === "uncategorized";
  const { showUnreadOnly, sortOrder } = useUrlViewPreferences();

  if (isUncategorized) {
    return <UncategorizedEntriesFallback />;
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 sm:mb-6">
        <div className="h-8 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
      <EntryListFallback
        filters={{ tagId, unreadOnly: showUnreadOnly, sortOrder }}
        skeletonCount={5}
      />
    </div>
  );
}

export function TagEntriesContent() {
  return (
    <ErrorBoundary message="Failed to load entries">
      <Suspense fallback={<TagEntriesFallback />}>
        <TagEntriesContentInner />
      </Suspense>
    </ErrorBoundary>
  );
}

/**
 * Tag Entries Content Component
 *
 * Client component that displays entries from a specific tag or uncategorized feeds.
 * Used by the page.tsx server component which handles SSR prefetching.
 */

"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { EntryPageLayout } from "@/components/entries";
import { NotFoundCard } from "@/components/ui";
import { useEntryPage } from "@/lib/hooks";
import { trpc } from "@/lib/trpc/client";
import { UncategorizedEntriesContentInner } from "@/app/(app)/uncategorized/UncategorizedEntriesContent";

/**
 * Content for regular tag entries.
 */
function TagContent({ tagId }: { tagId: string }) {
  const page = useEntryPage({
    viewId: "tag",
    viewScopeId: tagId,
    filters: { tagId },
  });

  // Fetch tag info
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

export function TagEntriesContent() {
  return (
    <Suspense>
      <TagEntriesContentInner />
    </Suspense>
  );
}

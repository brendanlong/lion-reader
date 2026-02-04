/**
 * Tag Entries Page
 *
 * Prefetches entry data for /tag/[tagId] route. AppRouter handles rendering.
 */

import { EntryListPage } from "@/components/entries/EntryListPage";

interface TagEntriesPageProps {
  params: Promise<{ tagId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function TagEntriesPage({ params, searchParams }: TagEntriesPageProps) {
  const { tagId } = await params;

  // Handle "uncategorized" pseudo-tag
  const isUncategorized = tagId === "uncategorized";
  const filters = isUncategorized ? { uncategorized: true as const } : { tagId };

  return (
    <EntryListPage filters={filters} searchParams={searchParams}>
      {null}
    </EntryListPage>
  );
}

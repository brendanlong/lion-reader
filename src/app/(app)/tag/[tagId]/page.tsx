/**
 * Tag Entries Page
 *
 * Displays entries from a specific tag or uncategorized feeds.
 */

import { EntryListPage } from "@/components/entries/EntryListPage";
import { TagEntriesContent } from "./TagEntriesContent";

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
      <TagEntriesContent />
    </EntryListPage>
  );
}

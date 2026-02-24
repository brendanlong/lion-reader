/**
 * Tag Entries Page
 *
 * Prefetches entry data for /tag/[tagId] route. AppRouter handles rendering.
 * The "uncategorized" pseudo-tag is handled by getFiltersFromPathname.
 */

import { EntryListPage } from "@/components/entries/EntryListPage";

interface TagEntriesPageProps {
  params: Promise<{ tagId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function TagEntriesPage({ params, searchParams }: TagEntriesPageProps) {
  const { tagId } = await params;

  return <EntryListPage pathname={`/tag/${tagId}`} searchParams={searchParams} />;
}

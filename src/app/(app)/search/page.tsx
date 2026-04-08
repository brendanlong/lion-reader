/**
 * Search Page
 *
 * Prefetches entry data for /search route with full-text search query.
 * AppRouter handles rendering.
 */

import { EntryListPage } from "@/components/entries/EntryListPage";

interface SearchPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default function SearchPage({ searchParams }: SearchPageProps) {
  return <EntryListPage pathname="/search" searchParams={searchParams} />;
}

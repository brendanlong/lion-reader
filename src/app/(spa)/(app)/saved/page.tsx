/**
 * Saved Articles Page
 *
 * Prefetches entry data for /saved route. AppRouter handles rendering.
 */

import { EntryListPage } from "@/components/entries/EntryListPage";

interface SavedArticlesPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default function SavedArticlesPage({ searchParams }: SavedArticlesPageProps) {
  return <EntryListPage pathname="/saved" searchParams={searchParams} />;
}

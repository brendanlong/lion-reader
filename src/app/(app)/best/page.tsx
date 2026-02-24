/**
 * Best Entries Page (Algorithmic Feed)
 *
 * Shows all unread entries sorted by predicted score descending.
 * Prefetches entry data for /best route. AppRouter handles rendering.
 */

import { EntryListPage } from "@/components/entries/EntryListPage";

interface BestEntriesPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default function BestEntriesPage({ searchParams }: BestEntriesPageProps) {
  return <EntryListPage pathname="/best" searchParams={searchParams} />;
}

/**
 * All Entries Page
 *
 * Prefetches entry data for /all route. AppRouter handles rendering.
 */

import { EntryListPage } from "@/components/entries/EntryListPage";

interface AllEntriesPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default function AllEntriesPage({ searchParams }: AllEntriesPageProps) {
  return <EntryListPage pathname="/all" searchParams={searchParams} />;
}

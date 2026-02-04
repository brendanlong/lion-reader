/**
 * Uncategorized Entries Page
 *
 * Prefetches entry data for /uncategorized route. AppRouter handles rendering.
 */

import { EntryListPage } from "@/components/entries/EntryListPage";

interface UncategorizedEntriesPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default function UncategorizedEntriesPage({ searchParams }: UncategorizedEntriesPageProps) {
  return (
    <EntryListPage filters={{ uncategorized: true }} searchParams={searchParams}>
      {null}
    </EntryListPage>
  );
}

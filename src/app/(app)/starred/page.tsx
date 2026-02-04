/**
 * Starred Entries Page
 *
 * Prefetches entry data for /starred route. AppRouter handles rendering.
 */

import { EntryListPage } from "@/components/entries/EntryListPage";

interface StarredEntriesPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default function StarredEntriesPage({ searchParams }: StarredEntriesPageProps) {
  return (
    <EntryListPage filters={{ starredOnly: true }} searchParams={searchParams}>
      {null}
    </EntryListPage>
  );
}

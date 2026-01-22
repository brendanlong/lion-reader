/**
 * Starred Entries Page
 *
 * Displays all starred entries.
 */

import { EntryListPage } from "@/components/entries/EntryListPage";
import { StarredEntriesContent } from "./StarredEntriesContent";

interface StarredEntriesPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default function StarredEntriesPage({ searchParams }: StarredEntriesPageProps) {
  return (
    <EntryListPage filters={{ starredOnly: true }} searchParams={searchParams}>
      <StarredEntriesContent />
    </EntryListPage>
  );
}

/**
 * Uncategorized Entries Page
 *
 * Displays entries from feeds with no tags.
 */

import { EntryListPage } from "@/components/entries/EntryListPage";
import { UncategorizedEntriesContent } from "./UncategorizedEntriesContent";

interface UncategorizedEntriesPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default function UncategorizedEntriesPage({ searchParams }: UncategorizedEntriesPageProps) {
  return (
    <EntryListPage filters={{ uncategorized: true }} searchParams={searchParams}>
      <UncategorizedEntriesContent />
    </EntryListPage>
  );
}

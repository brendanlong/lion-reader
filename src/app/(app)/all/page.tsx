/**
 * All Entries Page
 *
 * Displays all entries from all subscriptions.
 */

import { EntryListPage } from "@/components/entries/EntryListPage";
import { AllEntriesContent } from "./AllEntriesContent";

interface AllEntriesPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default function AllEntriesPage({ searchParams }: AllEntriesPageProps) {
  return (
    <EntryListPage filters={{}} searchParams={searchParams}>
      <AllEntriesContent />
    </EntryListPage>
  );
}

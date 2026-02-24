/**
 * Recently Read Entries Page
 *
 * Shows entries sorted by when their read state was last changed.
 * Unlike other lists, this defaults to showing both read and unread entries
 * (configured via getDefaultViewPreferences in entries-list-input.ts).
 */

import { EntryListPage } from "@/components/entries/EntryListPage";

interface RecentlyReadPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default function RecentlyReadPage({ searchParams }: RecentlyReadPageProps) {
  return <EntryListPage pathname="/recently-read" searchParams={searchParams} />;
}

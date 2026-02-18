/**
 * Recently Read Entries Page
 *
 * Shows entries sorted by when their read state was last changed.
 * Unlike other lists, this defaults to showing both read and unread entries.
 */

import { EntryListPage } from "@/components/entries/EntryListPage";

interface RecentlyReadPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default function RecentlyReadPage({ searchParams }: RecentlyReadPageProps) {
  return (
    <EntryListPage
      filters={{ sortBy: "readChanged" }}
      defaultUnreadOnly={false}
      searchParams={searchParams}
    >
      {null}
    </EntryListPage>
  );
}

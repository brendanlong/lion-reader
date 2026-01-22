/**
 * Saved Articles Page
 *
 * Displays saved articles (read later).
 */

import { EntryListPage } from "@/components/entries/EntryListPage";
import { SavedArticlesContent } from "./SavedArticlesContent";

interface SavedArticlesPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default function SavedArticlesPage({ searchParams }: SavedArticlesPageProps) {
  return (
    <EntryListPage filters={{ type: "saved" }} searchParams={searchParams}>
      <SavedArticlesContent />
    </EntryListPage>
  );
}

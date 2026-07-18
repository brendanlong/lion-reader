/**
 * /demo/highlights — Highlights demo page
 *
 * Server component that renders EntryArticle with static demo data when
 * ?entry= is present, or a static list of initially-starred entries
 * with crawlable links when no entry is selected. After hydration,
 * DemoLayoutContent switches to DemoRouter for full client-side interactivity.
 */

import { type Metadata } from "next";
import { pageOpenGraph } from "@/lib/metadata";
import { getDemoEntry, DEMO_ENTRIES, sortNewestFirst } from "../data";
import { DemoArticleView } from "../DemoArticleView";
import { DemoEntryListSSR } from "../DemoEntryListSSR";

interface Props {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const sp = await searchParams;
  const entryId = typeof sp.entry === "string" ? sp.entry : undefined;
  const entry = entryId ? getDemoEntry(entryId) : undefined;
  const title = entry?.title ? `${entry.title} - Lion Reader` : "Highlights - Lion Reader";
  const description = entry?.summary ?? "Starred and highlighted articles in Lion Reader.";
  return {
    title,
    description,
    openGraph: pageOpenGraph(title, description, entry?.ogImage),
    ...(entryId && { alternates: { canonical: `/demo/all?entry=${entryId}` } }),
  };
}

export default async function DemoHighlightsPage({ searchParams }: Props) {
  const sp = await searchParams;
  const entryId = typeof sp.entry === "string" ? sp.entry : undefined;
  const entry = entryId ? getDemoEntry(entryId) : undefined;

  if (entry) {
    return <DemoArticleView entry={entry} backHref="/demo/highlights" />;
  }

  const starredEntries = sortNewestFirst(DEMO_ENTRIES.filter((e) => e.starred));
  return (
    <DemoEntryListSSR
      entries={starredEntries}
      backHref="/demo/highlights"
      title="Highlights"
      // Highlights has no list actions (matching DemoRouter's `!isHighlights`).
      showActions={false}
    />
  );
}

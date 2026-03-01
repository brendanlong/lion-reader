/**
 * /demo/highlights — Highlights demo page
 *
 * Server component that renders EntryArticle with static demo data when
 * ?entry= is present, or a static list of initially-starred entries
 * with crawlable links when no entry is selected. After hydration,
 * DemoLayoutContent switches to DemoRouter for full client-side interactivity.
 */

import { type Metadata } from "next";
import { EntryArticle } from "@/components/entries/EntryArticle";
import { defaultOpenGraph } from "@/lib/metadata";
import { getDemoEntry, getDemoEntryArticleProps, DEMO_ENTRIES, sortNewestFirst } from "../data";
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
    openGraph: { ...defaultOpenGraph, title, description },
    ...(entryId && { alternates: { canonical: `/demo/all?entry=${entryId}` } }),
  };
}

export default async function DemoHighlightsPage({ searchParams }: Props) {
  const sp = await searchParams;
  const entryId = typeof sp.entry === "string" ? sp.entry : undefined;
  const entry = entryId ? getDemoEntry(entryId) : undefined;

  if (entry) {
    return <EntryArticle {...getDemoEntryArticleProps(entry)} />;
  }

  const starredEntries = sortNewestFirst(DEMO_ENTRIES.filter((e) => e.starred));
  return (
    <DemoEntryListSSR entries={starredEntries} backHref="/demo/highlights" title="Highlights" />
  );
}

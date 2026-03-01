/**
 * /demo/highlights — Highlights demo page
 *
 * Server component that renders EntryArticle with static demo data when
 * ?entry= is present, enabling SSR of entry content for SEO. After
 * hydration, DemoLayoutContent switches to DemoRouter for interactivity.
 */

import { type Metadata } from "next";
import { EntryArticle } from "@/components/entries/EntryArticle";
import { defaultOpenGraph } from "@/lib/metadata";
import { getDemoEntry, getDemoEntryArticleProps } from "../data";

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

  if (!entry) return null;

  return <EntryArticle {...getDemoEntryArticleProps(entry)} />;
}

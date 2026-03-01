/**
 * /demo/tag/[id] — Tag demo page
 *
 * Server component that renders EntryArticle with static demo data when
 * ?entry= is present, or a static entry list with crawlable links when
 * no entry is selected. After hydration, DemoLayoutContent switches to
 * DemoRouter for full client-side interactivity.
 */

import { type Metadata } from "next";
import { EntryArticle } from "@/components/entries/EntryArticle";
import { defaultOpenGraph } from "@/lib/metadata";
import {
  getDemoEntry,
  getDemoEntryArticleProps,
  getDemoTag,
  getDemoEntriesForTag,
} from "../../data";
import { DemoEntryListSSR } from "../../DemoEntryListSSR";

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { id } = await params;
  const sp = await searchParams;
  const entryId = typeof sp.entry === "string" ? sp.entry : undefined;
  const entry = entryId ? getDemoEntry(entryId) : undefined;
  const tag = getDemoTag(id);
  const title = entry?.title
    ? `${entry.title} - Lion Reader`
    : `${tag?.name ?? "Tag"} - Lion Reader`;
  const description = entry?.summary ?? tag?.description;
  return {
    title,
    description,
    openGraph: { ...defaultOpenGraph, title, description },
    ...(entryId && { alternates: { canonical: `/demo/all?entry=${entryId}` } }),
  };
}

export default async function DemoTagPage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const entryId = typeof sp.entry === "string" ? sp.entry : undefined;
  const entry = entryId ? getDemoEntry(entryId) : undefined;

  if (entry) {
    return <EntryArticle {...getDemoEntryArticleProps(entry)} />;
  }

  const tag = getDemoTag(id);
  return (
    <DemoEntryListSSR
      entries={getDemoEntriesForTag(id)}
      backHref={`/demo/tag/${id}`}
      title={tag?.name ?? "Tag"}
    />
  );
}

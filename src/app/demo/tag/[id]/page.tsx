/**
 * /demo/tag/[id] — Tag demo page
 *
 * Server component that renders EntryArticle with static demo data when
 * ?entry= is present, enabling SSR of entry content for SEO. After
 * hydration, DemoLayoutContent switches to DemoRouter for interactivity.
 */

import { type Metadata } from "next";
import { EntryArticle } from "@/components/entries/EntryArticle";
import { getDemoEntry, getDemoEntryArticleProps, getDemoTag } from "../../data";

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
  return {
    title: entry?.title
      ? `${entry.title} - Lion Reader Demo`
      : `${tag?.name ?? "Tag"} - Lion Reader Demo`,
  };
}

export default async function DemoTagPage({ searchParams }: Props) {
  const sp = await searchParams;
  const entryId = typeof sp.entry === "string" ? sp.entry : undefined;
  const entry = entryId ? getDemoEntry(entryId) : undefined;

  if (!entry) return null;

  return <EntryArticle {...getDemoEntryArticleProps(entry)} />;
}

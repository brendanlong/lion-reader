/**
 * /demo/tag/[id] — Tag demo page
 *
 * Statically prerendered entry list for each demo tag (the ids are
 * dev-authored constants, enumerated via generateStaticParams). Article views
 * (`?entry=`) never reach this page: the `beforeFiles` rewrite in
 * next.config.ts serves them from the prerendered /demo/entry/[entryId] route
 * instead (issue #1359) — do NOT read `searchParams` here, that would force
 * per-request rendering. After hydration, DemoLayoutContent switches to
 * DemoRouter for full client-side interactivity.
 */

import { type Metadata } from "next";
import { pageOpenGraph } from "@/lib/metadata";
import { DEMO_TAGS, getDemoTag, getDemoEntriesForTag } from "../../data";
import { DemoEntryListSSR } from "../../DemoEntryListSSR";

// Unknown ids 404 instead of being rendered (and cached) on demand.
export const dynamicParams = false;

export function generateStaticParams() {
  return DEMO_TAGS.map((tag) => ({ id: tag.id }));
}

interface Props {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const tag = getDemoTag(id);
  const title = `${tag?.name ?? "Tag"} - Lion Reader`;
  const description = tag?.description;
  return {
    title,
    description,
    openGraph: pageOpenGraph(title, description),
  };
}

export default async function DemoTagPage({ params }: Props) {
  const { id } = await params;
  const tag = getDemoTag(id);
  return (
    <DemoEntryListSSR
      entries={getDemoEntriesForTag(id)}
      backHref={`/demo/tag/${id}`}
      title={tag?.name ?? "Tag"}
    />
  );
}

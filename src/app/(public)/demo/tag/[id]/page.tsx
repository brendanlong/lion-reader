/**
 * /demo/tag/[id] — Tag demo page
 *
 * Statically prerendered for each demo tag (the ids are dev-authored
 * constants, enumerated via generateStaticParams). Article views (`?entry=`)
 * never reach this page: the `beforeFiles` rewrite in next.config.ts serves
 * them from the prerendered /demo/entry/[entryId] route instead (issue #1359)
 * — do NOT read `searchParams` here, that would force per-request rendering.
 */

import { type Metadata } from "next";
import { pageOpenGraph } from "@/lib/metadata";
import { DEMO_TAGS, getDemoTag } from "../../data";
import { DemoApp } from "../../DemoApp";

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
  return <DemoApp location={{ pathname: `/tag/${id}`, search: "" }} />;
}

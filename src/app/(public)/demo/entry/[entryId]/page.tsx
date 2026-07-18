/**
 * /demo/entry/[entryId] — statically prerendered demo article pages.
 *
 * This route exists so the `?entry=` article URLs can be served as static
 * files (issue #1359): reading `searchParams` in a server component forces
 * per-request rendering, so the public URLs (`/demo/all?entry=welcome`, and
 * `?entry=` on the subscription/tag/highlights pages) are rewritten here by
 * the `beforeFiles` rewrite in next.config.ts. The browser URL never changes —
 * the rewrite is server-internal — and every article page is prerendered at
 * build time from the dev-authored demo data.
 *
 * `dynamicParams = false`: an unknown-but-well-formed entry id 404s instead of
 * being rendered (and cached) on demand — the param is attacker-controllable
 * via the query string, and on-demand caching of arbitrary ids would grow the
 * route cache without bound.
 *
 * The SSR shell uses `/demo/all` as the back link even when the visitor came
 * via a subscription/tag URL: the shell only exists until hydration, when
 * DemoRouter re-derives the view (including the correct back link) from the
 * real browser URL.
 */

import { type Metadata } from "next";
import { pageOpenGraph } from "@/lib/metadata";
import { DEMO_ENTRIES, getDemoEntry } from "../../data";
import { DemoArticleView } from "../../DemoArticleView";

export const dynamicParams = false;

export function generateStaticParams() {
  return DEMO_ENTRIES.map((entry) => ({ entryId: entry.id }));
}

interface Props {
  params: Promise<{ entryId: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { entryId } = await params;
  const entry = getDemoEntry(entryId);
  const title = entry?.title ? `${entry.title} - Lion Reader` : "All Features - Lion Reader";
  const description =
    entry?.summary ??
    "Explore all of Lion Reader's features: feed support, reading experience, organization, and integrations.";
  return {
    title,
    description,
    openGraph: pageOpenGraph(title, description, entry?.ogImage),
    // The public URL for an article is the query form; this internal path is
    // only ever reached through the rewrite (or by guessing), so point
    // crawlers at the canonical query URL.
    alternates: { canonical: `/demo/all?entry=${entryId}` },
  };
}

export default async function DemoEntryPage({ params }: Props) {
  const { entryId } = await params;
  // dynamicParams=false means only generateStaticParams ids reach here, so the
  // lookup always succeeds; the fallback list satisfies the type system.
  const entry = getDemoEntry(entryId);
  if (!entry) {
    return null;
  }
  return <DemoArticleView entry={entry} backHref="/demo/all" />;
}

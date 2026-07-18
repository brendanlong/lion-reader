/**
 * /demo/all — All features demo page
 *
 * Statically prerendered entry list with crawlable links. Article views
 * (`?entry=`) never reach this page: the `beforeFiles` rewrite in
 * next.config.ts serves them from the prerendered /demo/entry/[entryId] route
 * instead (issue #1359) — do NOT read `searchParams` here, that would force
 * per-request rendering. After hydration, DemoLayoutContent switches to
 * DemoRouter for full client-side interactivity.
 */

import { type Metadata } from "next";
import { pageOpenGraph } from "@/lib/metadata";
import { DEMO_ENTRIES, sortNewestFirst } from "../data";
import { DemoEntryListSSR } from "../DemoEntryListSSR";

const TITLE = "All Features - Lion Reader";
const DESCRIPTION =
  "Explore all of Lion Reader's features: feed support, reading experience, organization, and integrations.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: pageOpenGraph(TITLE, DESCRIPTION),
};

export default function DemoAllPage() {
  return (
    <DemoEntryListSSR
      entries={sortNewestFirst([...DEMO_ENTRIES])}
      backHref="/demo/all"
      title="All Features"
    />
  );
}

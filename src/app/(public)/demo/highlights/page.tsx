/**
 * /demo/highlights — Highlights demo page
 *
 * Statically prerendered list of initially-starred entries with crawlable
 * links. Article views (`?entry=`) never reach this page: the `beforeFiles`
 * rewrite in next.config.ts serves them from the prerendered
 * /demo/entry/[entryId] route instead (issue #1359) — do NOT read
 * `searchParams` here, that would force per-request rendering. After
 * hydration, DemoLayoutContent switches to DemoRouter for full client-side
 * interactivity.
 */

import { type Metadata } from "next";
import { pageOpenGraph } from "@/lib/metadata";
import { DEMO_ENTRIES, sortNewestFirst } from "../data";
import { DemoEntryListSSR } from "../DemoEntryListSSR";

const TITLE = "Highlights - Lion Reader";
const DESCRIPTION = "Starred and highlighted articles in Lion Reader.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: pageOpenGraph(TITLE, DESCRIPTION),
};

export default function DemoHighlightsPage() {
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

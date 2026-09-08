/**
 * /demo/all — every demo article
 *
 * Statically prerendered. Article views (`?entry=`) never reach this page: the
 * `beforeFiles` rewrite in next.config.ts serves them from the prerendered
 * /demo/entry/[entryId] route instead (issue #1359) — do NOT read
 * `searchParams` here, that would force per-request rendering.
 */

import { type Metadata } from "next";
import { pageOpenGraph } from "@/lib/metadata";
import { DemoApp } from "../DemoApp";

const TITLE = "All Items - Lion Reader";
const DESCRIPTION =
  "Explore all of Lion Reader's features: feed support, reading experience, organization, and integrations.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: pageOpenGraph(TITLE, DESCRIPTION),
};

export default function Page() {
  return <DemoApp location={{ pathname: "/all", search: "" }} />;
}

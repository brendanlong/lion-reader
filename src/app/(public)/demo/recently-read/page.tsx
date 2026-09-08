/**
 * /demo/recently-read — demo articles in the order they were read
 *
 * Statically prerendered. Article views (`?entry=`) never reach this page: the
 * `beforeFiles` rewrite in next.config.ts serves them from the prerendered
 * /demo/entry/[entryId] route instead (issue #1359) — do NOT read
 * `searchParams` here, that would force per-request rendering.
 */

import { type Metadata } from "next";
import { pageOpenGraph } from "@/lib/metadata";
import { DemoApp } from "../DemoApp";

const TITLE = "Recently Read - Lion Reader";
const DESCRIPTION = "Articles you have recently read in Lion Reader.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: pageOpenGraph(TITLE, DESCRIPTION),
};

export default function Page() {
  return <DemoApp location={{ pathname: "/recently-read", search: "" }} />;
}

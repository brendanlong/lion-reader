/**
 * Demo Layout
 *
 * Server component that provides SEO metadata for the demo route hierarchy.
 * No auth check — demo is accessible to everyone.
 *
 * `force-static` (rather than plain static prerendering) so `useSearchParams()`
 * inside the reader tree returns empty params during the prerender instead of
 * bailing the whole page out to client rendering. The real location is
 * supplied by each page via `AppLocationProvider` (see DemoApp).
 */

import { type ReactNode } from "react";
import { type Metadata } from "next";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Lion Reader",
  description:
    "An AI-native, all-in-one reader for RSS feeds, newsletters, and read-later — with MCP, summaries, and narration. Fast, open source, and self-hostable.",
};

export default function DemoLayout({ children }: { children: ReactNode }) {
  return children;
}

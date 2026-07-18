/**
 * Demo Layout
 *
 * Server component that provides SEO metadata for the demo route hierarchy.
 * No auth check — demo is accessible to everyone.
 */

import { type ReactNode } from "react";
import { type Metadata } from "next";
import { DemoLayoutContent } from "./DemoLayoutContent";

export const metadata: Metadata = {
  title: "Lion Reader",
  description:
    "An AI-native, all-in-one reader for RSS feeds, newsletters, and read-later — with MCP, summaries, and narration. Fast, open source, and self-hostable.",
};

export default function DemoLayout({ children }: { children: ReactNode }) {
  return <DemoLayoutContent>{children}</DemoLayoutContent>;
}

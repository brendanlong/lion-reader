/**
 * Demo Layout
 *
 * Server component that provides SEO metadata for the demo route hierarchy.
 * No auth check — demo is accessible to everyone.
 *
 * `force-static` (rather than plain static prerendering) so `useSearchParams()`
 * inside the reader tree returns empty params during the prerender instead of
 * bailing the whole page out to client rendering (Next throws that bailout
 * whenever the hook is *called* during static generation). The real location
 * is supplied by each page via `AppLocationProvider`: the `?entry=` article
 * URLs are served from the `/demo/entry/[id]` route by the next.config.ts
 * rewrite, so at prerender time neither the pathname nor the query Next sees
 * is the one the browser will show (see DemoApp).
 *
 * The demo's narration voice is deploy-time config, so these pages are
 * re-rendered at startup (`/api/internal/revalidate-public`) to carry the
 * running server's, not the build machine's.
 */

import { type ReactNode } from "react";
import { type Metadata } from "next";
import { getDemoNarrationVoice } from "@/server/services/demo-narration";
import { DemoNarrationVoiceProvider } from "./DemoNarrationVoice";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Lion Reader",
  description:
    "An AI-native, all-in-one reader for RSS feeds, newsletters, and read-later — with MCP, summaries, and narration. Fast, open source, and self-hostable.",
};

export default function DemoLayout({ children }: { children: ReactNode }) {
  return (
    <DemoNarrationVoiceProvider voice={getDemoNarrationVoice()}>
      {children}
    </DemoNarrationVoiceProvider>
  );
}

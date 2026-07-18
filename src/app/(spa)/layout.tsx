/**
 * Root layout for the authenticated SPA and the auth/OAuth/utility surfaces.
 *
 * Dynamic (per-request SSR): reads the per-request CSP nonce so every inline
 * script satisfies the strict nonce-based CSP — these routes render
 * sanitized-but-untrusted entry HTML, and the CSP is the XSS backstop behind
 * the sanitizer (issue #1275, SECURITY.md). The public pages live under the
 * statically-prerendered `(public)/layout.tsx` instead — see
 * `src/app/root-document.tsx` for the split rationale (issue #1359).
 */

import { headers } from "next/headers";
import { RootDocument, rootMetadata, rootViewport } from "../root-document";

export const metadata = rootMetadata;
export const viewport = rootViewport;

export default async function SpaRootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Per-request CSP nonce, generated in src/proxy.ts (issue #1275). Every
  // inline <script> must carry it or the CSP blocks the script — that includes
  // next-themes' theme script, which gets it via ThemeProvider. Absent only if
  // the proxy didn't run, in which case the response has no CSP either.
  const headerStore = await headers();
  const nonce = headerStore.get("x-nonce") ?? undefined;

  return <RootDocument nonce={nonce}>{children}</RootDocument>;
}

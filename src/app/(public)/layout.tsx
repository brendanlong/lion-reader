/**
 * Root layout for the public pages: demo, login, register, terms, privacy.
 *
 * Deliberately reads NO request data (no `headers()`/`cookies()`), so these
 * routes can be statically prerendered at build time and served by the origin
 * as cached files with near-zero CPU — they're the pages an unauthenticated
 * traffic flood lands on (issue #1359).
 *
 * No CSP nonce: these routes get the relaxed static CSP
 * (`buildPublicContentSecurityPolicy` in `src/server/http/csp.ts`, applied by
 * `src/proxy.ts`), whose `'unsafe-inline'` allows the un-nonce'd inline
 * scripts. That is safe ONLY while these pages render zero user-supplied HTML
 * — demo articles are dev-authored constants, and the auth forms render user
 * input only as escaped React text. If a page here ever renders untrusted
 * HTML, it must move to the `(spa)` group (strict nonce CSP). See SECURITY.md.
 */

import { RootDocument, rootMetadata, rootViewport } from "../root-document";

export const metadata = rootMetadata;
export const viewport = rootViewport;

export default function PublicRootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <RootDocument>{children}</RootDocument>;
}

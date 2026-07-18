/**
 * Global 404 Page
 *
 * With the root layout split into two route groups (issue #1359) there is no
 * single root layout for a root `not-found.tsx` to render inside, so this uses
 * Next's `global-not-found` convention (enabled via
 * `experimental.globalNotFound` in next.config.ts): a complete, self-contained
 * document for any unmatched URL.
 *
 * Kept deliberately script-free: unmatched paths get the strict nonce CSP from
 * src/proxy.ts, but this document is statically prerendered, so an inline
 * theme script could never carry the per-request nonce and would be blocked.
 * Theming (issue #1350 — no white flash for dark-mode users) therefore relies
 * on the `@media (prefers-color-scheme)` fallback in globals.css, which covers
 * system-theme users; a user who explicitly forces dark on a light-scheme OS
 * gets the light 404 (an accepted edge case — no localStorage without a
 * script). The link is a plain <a>, since nothing hydrates here.
 */

import type { Metadata } from "next";
import { rootFontClassName } from "./root-document";
import "./globals.css";

export const metadata: Metadata = {
  title: "Page Not Found - Lion Reader",
};

export default function GlobalNotFound() {
  return (
    <html lang="en" className={rootFontClassName}>
      <body className="antialiased">
        <div className="bg-canvas flex min-h-screen flex-col items-center justify-center px-4 py-12 text-center">
          <h1 className="ui-text-2xl text-body font-bold">Page not found</h1>
          <p className="ui-text-sm text-muted mt-2">
            The page you&apos;re looking for doesn&apos;t exist or may have moved.
          </p>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- this
              document never hydrates (its scripts are blocked by the strict
              CSP), so a client-side <Link> would be dead weight; a plain
              anchor works without JS. */}
          <a
            href="/"
            className="btn-primary ui-text-sm mt-6 inline-flex min-h-[40px] items-center rounded-md px-4 font-medium"
          >
            Back to Lion Reader
          </a>
        </div>
      </body>
    </html>
  );
}

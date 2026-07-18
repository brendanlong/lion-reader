/**
 * PageLink Component
 *
 * A link for full-page navigation to standalone routes that live *outside* the
 * SPA shell — the auth pages, the public legal pages (privacy/terms), and the
 * demo's sign-in/sign-up buttons.
 *
 * Renders a plain <a>, so clicking triggers a real browser navigation: it loads
 * the target's HTML document and issues no Next.js RSC (`?_rsc=`) request and
 * no viewport/hover prefetch, unlike `next/link`.
 * Modifier/middle clicks, `target`, and `download` all fall through to the
 * browser natively (a plain <a> needs no JS for that).
 *
 * Use this instead of `next/link` for any internal navigation that should leave
 * or enter the SPA. For soft, client-side navigation *within* the SPA, use
 * `<ClientLink>` instead. Between the two, never hand-roll a raw <a> for an
 * internal href.
 *
 * Deliberately not a client component (no `"use client"`, no handlers) so it can
 * render inside server components like the legal pages.
 *
 * @example
 * ```tsx
 * <PageLink href="/login" className="text-body font-medium hover:underline">
 *   Sign in
 * </PageLink>
 * ```
 */

import { type ReactNode, type AnchorHTMLAttributes } from "react";

export interface PageLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  /** Link destination (an internal route). */
  href: string;
  /** Link content. */
  children: ReactNode;
}

export function PageLink({ href, children, ...props }: PageLinkProps) {
  return (
    <a href={href} {...props}>
      {children}
    </a>
  );
}

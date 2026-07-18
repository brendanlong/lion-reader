/**
 * PageLink Component
 *
 * A link for navigation to standalone routes that live *outside* the SPA shell —
 * the auth pages, the public legal pages (privacy/terms), and the demo's
 * sign-in/sign-up buttons.
 *
 * Renders a Next.js `<Link prefetch={false}>`. Clicking does a soft, client-side
 * RSC navigation across the route-group boundary (no full document reload), but
 * with **no** prefetching: in the App Router `prefetch={false}` disables the
 * background prefetch on *both* viewport and hover, so a page full of PageLinks
 * never fires a storm of `?_rsc=` requests. Modifier/middle clicks, `target`, and
 * `download` fall through to the browser natively because Link renders a real
 * `<a href>`.
 *
 * This is the **one** sanctioned place `next/link` is used — always with
 * `prefetch={false}`. Use it for internal navigation that crosses *into or out
 * of* the SPA. For soft navigation *within* the SPA (rendered from the client
 * cache with no server fetch at all), use `<ClientLink>` instead. Between the
 * two, never use `next/link` directly nor hand-roll a raw <a> for an internal
 * href.
 *
 * Note: logout is deliberately NOT a PageLink — it uses a full `window.location`
 * navigation so the reload wipes the module-level per-user caches (QueryClient,
 * subscription lookup map). See `AppLayoutContent`.
 *
 * Not a client component itself (no `"use client"`, no handlers), so it can
 * render inside server components like the legal pages; `<Link>` is a client
 * component and works fine when rendered from a server component.
 *
 * @example
 * ```tsx
 * <PageLink href="/login" className="text-body font-medium hover:underline">
 *   Sign in
 * </PageLink>
 * ```
 */

import Link from "next/link";
import { type ReactNode, type ComponentPropsWithoutRef } from "react";

export interface PageLinkProps extends Omit<
  ComponentPropsWithoutRef<typeof Link>,
  "href" | "prefetch"
> {
  /** Link destination (an internal route). */
  href: string;
  /** Link content. */
  children: ReactNode;
}

export function PageLink({ href, children, ...props }: PageLinkProps) {
  return (
    <Link href={href} prefetch={false} {...props}>
      {children}
    </Link>
  );
}

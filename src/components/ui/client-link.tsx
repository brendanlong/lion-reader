/**
 * ClientLink Component
 *
 * A link component for client-side navigation without SSR.
 * Uses pushState directly instead of Next.js Link to avoid prefetching
 * and SSR navigation that we don't want in our SPA-style app.
 */

"use client";

import { type MouseEvent, type ReactNode, type AnchorHTMLAttributes } from "react";
import { handleClientNav } from "@/lib/navigation";
import { useAppHref } from "@/lib/hooks/useAppLocation";

export interface ClientLinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "onClick"
> {
  /**
   * Link destination, relative to the SPA mount point (`/all`, `/tag/:id`).
   * The route base is prefixed automatically — `/demo/all` under the demo.
   */
  href: string;
  /** Link content */
  children: ReactNode;
  /** Called with the (SPA-relative) href after navigation (e.g., to close a menu) */
  onNavigate?: (href: string) => void;
  /** Called on mousedown with the (SPA-relative) href (e.g., to prefetch data) */
  onPrefetch?: (href: string) => void;
}

/**
 * Link component for client-side navigation.
 *
 * Use this instead of Next.js `<Link>` for navigation within the app.
 * It uses pushState directly, avoiding SSR fetches and prefetching.
 *
 * Modifier/middle clicks, and `target`/`download` anchors, fall through to the
 * browser (new tab / new window / download) instead of being intercepted.
 *
 * @example
 * ```tsx
 * <ClientLink href="/settings" className="text-accent">
 *   Settings
 * </ClientLink>
 * ```
 */
export function ClientLink({ href, children, onNavigate, onPrefetch, ...props }: ClientLinkProps) {
  const appHref = useAppHref();
  const target = appHref(href);
  return (
    <a
      href={target}
      onClick={(e: MouseEvent<HTMLAnchorElement>) =>
        handleClientNav(e, target, onNavigate ? () => onNavigate(href) : undefined)
      }
      onMouseDown={onPrefetch ? () => onPrefetch(href) : undefined}
      {...props}
    >
      {children}
    </a>
  );
}

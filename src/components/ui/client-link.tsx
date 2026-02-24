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

export interface ClientLinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href" | "onClick"
> {
  /** Link destination */
  href: string;
  /** Link content */
  children: ReactNode;
  /** Called after navigation (e.g., to close a menu) */
  onNavigate?: () => void;
  /** Called on mousedown with the link href (e.g., to prefetch data) */
  onPrefetch?: (href: string) => void;
}

/**
 * Link component for client-side navigation.
 *
 * Use this instead of Next.js `<Link>` for navigation within the app.
 * It uses pushState directly, avoiding SSR fetches and prefetching.
 *
 * Supports cmd/ctrl+click to open in a new tab.
 *
 * @example
 * ```tsx
 * <ClientLink href="/settings" className="text-blue-600">
 *   Settings
 * </ClientLink>
 * ```
 */
export function ClientLink({ href, children, onNavigate, onPrefetch, ...props }: ClientLinkProps) {
  return (
    <a
      href={href}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => handleClientNav(e, href, onNavigate)}
      onMouseDown={onPrefetch ? () => onPrefetch(href) : undefined}
      {...props}
    >
      {children}
    </a>
  );
}

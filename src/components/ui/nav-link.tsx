/**
 * NavLink Component
 *
 * A styled navigation link with active state, consistent touch targets,
 * and optional count badge. Used in the sidebar and other navigation areas.
 */

"use client";

import { type ReactNode } from "react";
import { ClientLink } from "./client-link";

export interface NavLinkProps {
  /** Link destination */
  href: string;
  /** Whether this link is currently active */
  isActive: boolean;
  /** Link content (text, icons, etc.) */
  children: ReactNode;
  /** Optional count element (renders as-is, typically from Suspense) */
  countElement?: ReactNode;
  /** Called when link is clicked */
  onClick?: () => void;
  /** Additional class name */
  className?: string;
}

/**
 * Navigation link with consistent styling for active/inactive states.
 * Ensures 44px minimum height for touch targets (WCAG compliance).
 *
 * @example
 * ```tsx
 * <NavLink
 *   href="/all"
 *   isActive={pathname === "/all"}
 *   countElement={<UnreadCount />}
 * >
 *   All Items
 * </NavLink>
 * ```
 */
export function NavLink({
  href,
  isActive,
  children,
  countElement,
  onClick,
  className = "",
}: NavLinkProps) {
  return (
    <ClientLink
      href={href}
      onNavigate={onClick}
      className={`ui-text-sm flex min-h-[44px] items-center justify-between rounded-md px-3 py-2 font-medium transition-colors ${
        isActive
          ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
          : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
      } ${className}`}
    >
      <span className="truncate">{children}</span>
      {countElement}
    </ClientLink>
  );
}

/**
 * Props for NavLinkWithIcon - NavLink with leading icon or indicator
 */
export interface NavLinkWithIconProps extends Omit<NavLinkProps, "children" | "countElement"> {
  /** Icon or indicator element to show before the label */
  icon?: ReactNode;
  /** Text label */
  label: string;
  /** Optional count to display (only shown if > 0) */
  count?: number;
}

/**
 * Navigation link with a leading icon and label.
 * Useful for tag links with color indicators.
 *
 * @example
 * ```tsx
 * <NavLinkWithIcon
 *   href={`/tag/${tag.id}`}
 *   isActive={pathname === `/tag/${tag.id}`}
 *   icon={<ColorDot color={tag.color} />}
 *   label={tag.name}
 *   count={tag.unreadCount}
 * />
 * ```
 */
export function NavLinkWithIcon({
  href,
  isActive,
  icon,
  label,
  count,
  onClick,
  className = "",
}: NavLinkWithIconProps) {
  return (
    <ClientLink
      href={href}
      onNavigate={onClick}
      className={`ui-text-sm flex min-h-[44px] flex-1 items-center gap-2 rounded-md px-3 py-2 transition-colors ${
        isActive
          ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
          : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
      } ${className}`}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="ui-text-xs ml-auto shrink-0 text-zinc-500 dark:text-zinc-400">
          ({count})
        </span>
      )}
    </ClientLink>
  );
}

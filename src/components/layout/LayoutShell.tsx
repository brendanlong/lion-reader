/**
 * LayoutShell Component (SSR-safe)
 *
 * Pure structural layout component extracted from AppLayoutContent.
 * No "use client" directive - SSR-compatible.
 * Interactive elements (overlay clicks, menu buttons) are passed as slots.
 */

import { type ReactNode } from "react";
import { ClientLink } from "@/components/ui/client-link";

export interface LayoutShellProps {
  /** Whether the mobile sidebar is open */
  sidebarOpen: boolean;
  /** The href for the sidebar title link (e.g., "/all" or "/?view=all") */
  sidebarTitleHref?: string;
  /** The sidebar content (navigation, feed list, etc.) */
  sidebarContent: ReactNode;
  /** Mobile sidebar overlay (backdrop with onClick to close) */
  sidebarOverlay?: ReactNode;
  /** Close button inside sidebar header (has onClick) */
  sidebarCloseButton?: ReactNode;
  /** Hamburger menu button for mobile (has onClick) */
  mobileMenuButton?: ReactNode;
  /** Right side of the header (subscribe + user menu, or sign up/sign in) */
  headerRight: ReactNode;
  /** Main content area */
  children: ReactNode;
}

export function LayoutShell({
  sidebarOpen,
  sidebarTitleHref = "/all",
  sidebarContent,
  sidebarOverlay,
  sidebarCloseButton,
  mobileMenuButton,
  headerRight,
  children,
}: LayoutShellProps) {
  return (
    <div className="flex h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && sidebarOverlay}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 transform border-r border-zinc-200 bg-white transition-transform duration-200 ease-in-out lg:static lg:translate-x-0 dark:border-zinc-800 dark:bg-zinc-900 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Sidebar header */}
        <div className="flex h-14 items-center justify-between border-b border-zinc-200 px-4 dark:border-zinc-800">
          <ClientLink
            href={sidebarTitleHref}
            className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50"
          >
            Lion Reader
          </ClientLink>
          {sidebarCloseButton}
        </div>

        {/* Sidebar content */}
        <div className="h-[calc(100%-3.5rem)]">{sidebarContent}</div>
      </aside>

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="flex h-14 items-center justify-between border-b border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-zinc-900">
          {/* Mobile menu button */}
          {mobileMenuButton}

          {/* Spacer for desktop */}
          <div className="hidden lg:block" />

          {/* Right side actions */}
          {headerRight}
        </header>

        {/* Main content */}
        {children}
      </div>
    </div>
  );
}

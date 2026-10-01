/**
 * LayoutShell Component
 *
 * The reader's structural layout shared by the app and the public demo: the
 * sidebar (with its mobile open/close state) and the header. Callers supply
 * the header's right side and the main content.
 */

"use client";

import { useState, type ReactNode } from "react";
import { ClientLink } from "@/components/ui/client-link";
import { CloseIcon, MenuIcon } from "@/components/ui/icons";
import { Sidebar } from "@/components/layout/Sidebar";
import { DynamicFavicon } from "@/components/layout/DynamicFavicon";

const CONTROL_BUTTON_CLASS =
  "control-outline text-muted hover:bg-surface-muted flex h-10 w-10 items-center justify-center rounded-md active:bg-zinc-200 lg:hidden dark:active:bg-zinc-700";

interface LayoutShellProps {
  /** Right side of the header (subscribe + user menu, or sign up/sign in) */
  headerRight: ReactNode;
  /** Main content area */
  children: ReactNode;
}

export function LayoutShell({ headerRight, children }: LayoutShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="bg-canvas flex h-screen">
      <DynamicFavicon />
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`border-edge bg-surface fixed inset-y-0 left-0 z-50 w-64 transform border-r transition-transform duration-200 ease-in-out lg:static lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Sidebar header */}
        <div className="border-edge flex h-14 items-center justify-between border-b px-4">
          <ClientLink href="/all" className="ui-text-lg text-body font-semibold">
            Lion Reader
          </ClientLink>
          <button
            onClick={() => setSidebarOpen(false)}
            className={CONTROL_BUTTON_CLASS}
            aria-label="Close navigation menu"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Sidebar content */}
        <div className="h-[calc(100%-3.5rem)]">
          <Sidebar onClose={() => setSidebarOpen(false)} />
        </div>
      </aside>

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Header */}
        <header className="border-edge bg-surface flex h-14 items-center justify-between border-b px-4">
          <button
            onClick={() => setSidebarOpen(true)}
            className={CONTROL_BUTTON_CLASS}
            aria-label="Open navigation menu"
          >
            <MenuIcon className="h-5 w-5" />
          </button>

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

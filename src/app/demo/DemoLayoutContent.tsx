/**
 * DemoLayoutContent Component
 *
 * Client component wrapping the demo layout with providers and LayoutShell.
 * Mirrors the pattern used by AppLayoutContent for the real app.
 *
 * Uses hydration-based switching: server HTML shows children (which contain
 * SSR-rendered EntryArticle content from page.tsx), then switches to DemoRouter
 * after hydration for full client-side interactivity.
 */

"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { CloseIcon, MenuIcon } from "@/components/ui/icon-button";
import { LayoutShell } from "@/components/layout/LayoutShell";
import {
  ScrollContainerProvider,
  MainScrollContainer,
} from "@/components/layout/ScrollContainerContext";
import { TRPCProvider } from "@/lib/trpc/provider";
import { AppearanceProvider } from "@/lib/appearance/AppearanceProvider";
import { DemoSidebar } from "./DemoSidebar";
import { DemoRouter } from "./DemoRouter";
import { DemoListSkeleton } from "./DemoListSkeleton";
import { DemoStateProvider } from "./DemoStateContext";

interface DemoLayoutContentProps {
  children: ReactNode;
}

const emptySubscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export function DemoLayoutContent({ children }: DemoLayoutContentProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const hydrated = useSyncExternalStore(emptySubscribe, getClientSnapshot, getServerSnapshot);

  return (
    <TRPCProvider>
      <AppearanceProvider>
        <DemoStateProvider>
          <ScrollContainerProvider>
            <LayoutShell
              sidebarOpen={sidebarOpen}
              sidebarTitleHref="/demo/all"
              sidebarContent={<DemoSidebar onClose={() => setSidebarOpen(false)} />}
              sidebarOverlay={
                <div
                  className="fixed inset-0 z-40 bg-black/50 lg:hidden"
                  onClick={() => setSidebarOpen(false)}
                />
              }
              sidebarCloseButton={
                <button
                  onClick={() => setSidebarOpen(false)}
                  className="text-subtle flex h-10 w-10 items-center justify-center rounded-md hover:bg-zinc-100 active:bg-zinc-200 lg:hidden dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
                  aria-label="Close navigation menu"
                >
                  <CloseIcon className="h-5 w-5" />
                </button>
              }
              mobileMenuButton={
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="text-subtle flex h-10 w-10 items-center justify-center rounded-md hover:bg-zinc-100 active:bg-zinc-200 lg:hidden dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
                  aria-label="Open navigation menu"
                >
                  <MenuIcon className="h-5 w-5" />
                </button>
              }
              headerRight={
                <div className="flex items-center gap-2">
                  <Link
                    href="/register"
                    className="btn-primary ui-text-sm inline-flex min-h-[40px] items-center gap-1.5 rounded-md px-3 font-medium"
                  >
                    Sign Up
                  </Link>
                  <Link
                    href="/login"
                    className="ui-text-sm border-edge-strong bg-surface text-body inline-flex min-h-[40px] items-center gap-1.5 rounded-md border px-3 font-medium transition-colors hover:bg-zinc-50 active:bg-zinc-100 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
                  >
                    Sign In
                  </Link>
                </div>
              }
            >
              <MainScrollContainer className="flex-1 overflow-y-auto bg-zinc-50 dark:bg-zinc-950">
                {hydrated ? <DemoRouter /> : (children ?? <DemoListSkeleton />)}
              </MainScrollContainer>
            </LayoutShell>
          </ScrollContainerProvider>
        </DemoStateProvider>
      </AppearanceProvider>
    </TRPCProvider>
  );
}

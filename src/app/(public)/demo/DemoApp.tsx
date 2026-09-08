/**
 * DemoApp
 *
 * The public demo: the app's own reader tree — `Sidebar`, `UnifiedEntriesContent`
 * and every hook behind them — mounted under `/demo` and wired to the in-memory
 * demo store instead of the network. There is no demo-specific router or state;
 * a change to how the app routes, caches, or renders entries shows up here
 * because it is the same code.
 *
 * What differs from `AppLayoutContent`, and why:
 * - tRPC resolves through `createHandlerLink(store)` (`./store.ts`), and the
 *   cache is pre-seeded for the prerendered location (`./seed.ts`) so the static
 *   HTML carries the real content — `PrerenderedCacheProvider` lets the
 *   cache-gated components render it during SSR.
 * - `AppLocationProvider` strips the `/demo` prefix and, until the URL has
 *   settled after hydration, reports the location the page was prerendered
 *   for (see useAppLocation).
 * - No realtime/SSE, announcement banner, or auth-error handling: those are
 *   session features. The header offers sign-up/sign-in instead of the user
 *   menu.
 * - `UnifiedEntriesContent` is rendered directly rather than via `AppRouter`,
 *   whose settings/subscribe branches would ship their bundles to the public
 *   landing page for routes the demo doesn't have; the two shell hooks
 *   `AppRouter` hosts are called here instead (this component is likewise
 *   always mounted).
 */

"use client";

import { useEffect, useState } from "react";
import { HydrationBoundary } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { CloseIcon, MenuIcon } from "@/components/ui/icons";
import { PageLink } from "@/components/ui/page-link";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { LayoutShell } from "@/components/layout/LayoutShell";
import { Sidebar } from "@/components/layout/Sidebar";
import {
  ScrollContainerProvider,
  MainScrollContainer,
} from "@/components/layout/ScrollContainerContext";
import { KeyboardShortcutsProvider } from "@/components/keyboard/KeyboardShortcutsProvider";
import { UnifiedEntriesContent } from "@/components/entries/UnifiedEntriesContent";
import {
  EntryContentOptionsProvider,
  type EntryContentOptions,
} from "@/components/entries/EntryContentOptions";
import { TRPCProvider } from "@/lib/trpc/provider";
import { createHandlerLink } from "@/lib/trpc/handler-link";
import { AppearanceProvider } from "@/lib/appearance/AppearanceProvider";
import { AppLocationProvider, type AppLocation } from "@/lib/hooks/useAppLocation";
import { PrerenderedCacheProvider } from "@/lib/hooks/useIsHydrated";
import { useEntryListRefreshOnNavigate } from "@/lib/hooks/useEntryListRefreshOnNavigate";
import { useEntryListScrollResetOnNavigate } from "@/lib/hooks/useEntryListScrollResetOnNavigate";
import { clientReplace } from "@/lib/navigation";
import { DEMO_BASE_PATH } from "@/lib/routes";
import { createDemoStore } from "./store";
import { buildDemoDehydratedState } from "./seed";
import { demoEntrySlots } from "./DemoEntrySlots";

const ENTRY_CONTENT_OPTIONS: EntryContentOptions = {
  // Narration generation is a server feature; the demo has no backend.
  hideNarration: true,
  // A prerendered page can't know the visitor's zone. Formatting the article
  // date in a common one keeps the post-hydration switch to local time a small
  // correction for most visitors rather than a jump from the host's UTC.
  ssrDateTimeZone: "America/Los_Angeles",
  renderSlots: demoEntrySlots,
};

const CONTROL_BUTTON_CLASS =
  "control-outline text-muted hover:bg-surface-muted flex h-10 w-10 items-center justify-center rounded-md active:bg-zinc-200 lg:hidden dark:active:bg-zinc-700";

interface DemoAppProps {
  /**
   * The app-relative location this page is prerendered for. The `?entry=`
   * article URLs are served from the `/demo/entry/[id]` route (next.config.ts
   * rewrite), so the page — not the request — is what knows the real location.
   */
  location: AppLocation;
}

function DemoShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Always-mounted shell hooks (see AppRouter for why they must live here).
  useEntryListRefreshOnNavigate();
  useEntryListScrollResetOnNavigate();

  return (
    <LayoutShell
      sidebarOpen={sidebarOpen}
      sidebarTitleHref="/all"
      sidebarContent={<Sidebar onClose={() => setSidebarOpen(false)} />}
      sidebarOverlay={
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      }
      sidebarCloseButton={
        <button
          onClick={() => setSidebarOpen(false)}
          className={CONTROL_BUTTON_CLASS}
          aria-label="Close navigation menu"
        >
          <CloseIcon className="h-5 w-5" />
        </button>
      }
      mobileMenuButton={
        <button
          onClick={() => setSidebarOpen(true)}
          className={CONTROL_BUTTON_CLASS}
          aria-label="Open navigation menu"
        >
          <MenuIcon className="h-5 w-5" />
        </button>
      }
      headerRight={
        <div className="flex items-center gap-2">
          <PageLink
            href="/register"
            className="btn-primary ui-text-sm inline-flex min-h-[40px] items-center gap-1.5 rounded-md px-3 font-medium"
          >
            Sign Up
          </PageLink>
          <PageLink
            href="/login"
            className="ui-text-sm border-edge-strong bg-surface text-body hover:bg-surface-muted inline-flex min-h-[40px] items-center gap-1.5 rounded-md border px-3 font-medium transition-colors active:bg-zinc-100 dark:active:bg-zinc-700"
          >
            Sign In
          </PageLink>
        </div>
      }
    >
      <MainScrollContainer className="bg-canvas flex-1 overflow-y-auto">
        <ErrorBoundary message="Something went wrong while loading this page.">
          <UnifiedEntriesContent />
        </ErrorBoundary>
      </MainScrollContainer>
    </LayoutShell>
  );
}

export function DemoApp({ location }: DemoAppProps) {
  // One store per page load, created identically on the server and the client
  // from the fixtures plus the prerendered location.
  const [store] = useState(() => createDemoStore());
  const [links] = useState(() => [createHandlerLink(store.handlers)]);
  const [dehydratedState] = useState(() => buildDemoDehydratedState(store, location));

  // The prerendered location stays authoritative through hydration and until
  // the browser URL is settled, then the live URL takes over.
  const [ssrLocation, setSsrLocation] = useState<AppLocation | null>(location);
  useEffect(() => {
    // Deferred past this commit's effects: Next patches history.replaceState
    // (to sync usePathname) in its own root effect, which runs after this one,
    // so a synchronous replace here would change the URL without the router
    // noticing.
    const timer = setTimeout(() => {
      // A direct visit to the internal rewrite target (/demo/entry/<id>) works,
      // but the public form of that URL is the query one; normalize so
      // navigation from here builds the URLs everything else links to.
      const match = window.location.pathname.match(/^\/demo\/entry\/([^/]+)$/);
      if (match) {
        clientReplace(`${DEMO_BASE_PATH}${location.pathname}?entry=${match[1]}`);
      }
      setSsrLocation(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [location.pathname]);

  return (
    <TRPCProvider links={links}>
      <HydrationBoundary state={dehydratedState}>
        <AppLocationProvider basePath={DEMO_BASE_PATH} ssrLocation={ssrLocation}>
          <PrerenderedCacheProvider>
            <EntryContentOptionsProvider value={ENTRY_CONTENT_OPTIONS}>
              <AppearanceProvider>
                <KeyboardShortcutsProvider>
                  <ScrollContainerProvider>
                    <Toaster position="bottom-right" richColors closeButton />
                    <DemoShell />
                  </ScrollContainerProvider>
                </KeyboardShortcutsProvider>
              </AppearanceProvider>
            </EntryContentOptionsProvider>
          </PrerenderedCacheProvider>
        </AppLocationProvider>
      </HydrationBoundary>
    </TRPCProvider>
  );
}

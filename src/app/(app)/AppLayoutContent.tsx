/**
 * App Layout Content
 *
 * Client component with the main application layout UI.
 * Includes sidebar navigation and header.
 * Uses LayoutShell for the structural layout, passing interactive elements as slots.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ClientLink } from "@/components/ui/client-link";
import {
  CloseIcon,
  MenuIcon,
  PlusIcon,
  UserIcon,
  ChevronDownIcon,
} from "@/components/ui/icon-button";
import { Toaster, toast } from "sonner";
import { Sidebar } from "@/components/layout/Sidebar";
import { FileUploadButton } from "@/components/saved/FileUploadButton";
import { UserEmail } from "@/components/layout/UserEmail";
import { RealtimeProvider } from "@/components/layout/RealtimeProvider";
import { OfflineBanner } from "@/components/layout/OfflineBanner";
import { LayoutShell } from "@/components/layout/LayoutShell";
import {
  ScrollContainerProvider,
  MainScrollContainer,
} from "@/components/layout/ScrollContainerContext";
import { KeyboardShortcutsProvider } from "@/components/keyboard/KeyboardShortcutsProvider";
import { AppRouter } from "@/components/app/AppRouter";
import { trpc } from "@/lib/trpc/client";
import { clearSubscriptionLookupMap } from "@/lib/cache/count-cache";
import { AppearanceProvider } from "@/lib/appearance/AppearanceProvider";
import { type SyncCursors } from "@/lib/events/cursors";

interface AppLayoutContentProps {
  initialCursors: SyncCursors;
}

export function AppLayoutContent({ initialCursors }: AppLayoutContentProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      // Clear the session cookie
      document.cookie = "session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
      // Drop all cached data before the next login. The browser QueryClient and
      // the subscription lookup map are module-level singletons that outlive the
      // session, so without this a different account signing in on the same tab
      // (SPA navigation, no full reload) would be served the previous user's
      // article bodies, lists, counts, and subscription titles.
      queryClient.clear();
      clearSubscriptionLookupMap();
      router.push("/login");
      router.refresh();
    },
    onError: () => {
      toast.error("Failed to sign out");
    },
  });

  const handleLogout = () => {
    logoutMutation.mutate();
  };

  return (
    <AppearanceProvider>
      <RealtimeProvider initialCursors={initialCursors}>
        <KeyboardShortcutsProvider>
          <ScrollContainerProvider>
            <Toaster position="bottom-right" richColors closeButton />
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
                  {/* Upload button (save an article for later) */}
                  <FileUploadButton />

                  {/* Subscribe button */}
                  <ClientLink
                    href="/subscribe"
                    className="btn-primary ui-text-sm inline-flex min-h-[40px] items-center gap-1.5 rounded-md px-3 font-medium"
                  >
                    <PlusIcon className="h-4 w-4" />
                    <span className="hidden sm:inline">Subscribe</span>
                  </ClientLink>

                  {/* User menu */}
                  <div className="relative">
                    <button
                      onClick={() => setUserMenuOpen(!userMenuOpen)}
                      className="ui-text-sm border-edge-strong bg-surface text-body hover:bg-surface-hover flex min-h-[40px] items-center gap-2 rounded-md border px-3 transition-colors active:bg-zinc-100 dark:active:bg-zinc-700"
                      aria-expanded={userMenuOpen}
                      aria-haspopup="true"
                    >
                      <span className="hidden max-w-[150px] truncate sm:inline">
                        <UserEmail />
                      </span>
                      <span className="sm:hidden" aria-label="Account menu">
                        <UserIcon className="h-5 w-5" />
                      </span>
                      <ChevronDownIcon
                        className={`h-4 w-4 transition-transform ${userMenuOpen ? "rotate-180" : ""}`}
                      />
                    </button>

                    {/* Dropdown menu */}
                    {userMenuOpen && (
                      <>
                        <div
                          className="fixed inset-0 z-10"
                          onClick={() => setUserMenuOpen(false)}
                        />
                        <div className="border-edge-strong bg-surface absolute right-0 z-20 mt-1 w-48 rounded-md border py-1 shadow-lg">
                          <ClientLink
                            href="/settings"
                            onNavigate={() => setUserMenuOpen(false)}
                            className="ui-text-sm text-body flex min-h-[44px] items-center px-4 hover:bg-zinc-100 active:bg-zinc-200 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
                          >
                            Settings
                          </ClientLink>
                          <ClientLink
                            href="/settings/sessions"
                            onNavigate={() => setUserMenuOpen(false)}
                            className="ui-text-sm text-body flex min-h-[44px] items-center px-4 hover:bg-zinc-100 active:bg-zinc-200 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
                          >
                            Sessions
                          </ClientLink>
                          <hr className="border-edge-strong my-1" />
                          <button
                            onClick={() => {
                              setUserMenuOpen(false);
                              handleLogout();
                            }}
                            disabled={logoutMutation.isPending}
                            className="ui-text-sm text-body flex min-h-[44px] w-full items-center px-4 text-left hover:bg-zinc-100 active:bg-zinc-200 disabled:opacity-50 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
                          >
                            {logoutMutation.isPending ? "Signing out..." : "Sign out"}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              }
            >
              {/* Offline banner */}
              <OfflineBanner />

              {/* Main content */}
              <MainScrollContainer className="bg-canvas flex-1 overflow-y-auto">
                <AppRouter />
              </MainScrollContainer>
            </LayoutShell>
          </ScrollContainerProvider>
        </KeyboardShortcutsProvider>
      </RealtimeProvider>
    </AppearanceProvider>
  );
}

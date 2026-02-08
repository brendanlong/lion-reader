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
import { AppearanceProvider } from "@/lib/appearance/AppearanceProvider";
import { type SyncCursors } from "@/lib/hooks/useRealtimeUpdates";

interface AppLayoutContentProps {
  initialCursors: SyncCursors;
}

export function AppLayoutContent({ initialCursors }: AppLayoutContentProps) {
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      // Clear the session cookie
      document.cookie = "session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
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
                  className="flex h-10 w-10 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 active:bg-zinc-200 lg:hidden dark:text-zinc-400 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
                  aria-label="Close navigation menu"
                >
                  <CloseIcon className="h-5 w-5" />
                </button>
              }
              mobileMenuButton={
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="flex h-10 w-10 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 active:bg-zinc-200 lg:hidden dark:text-zinc-400 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
                  aria-label="Open navigation menu"
                >
                  <MenuIcon className="h-5 w-5" />
                </button>
              }
              headerRight={
                <div className="flex items-center gap-2">
                  {/* Subscribe button */}
                  <ClientLink
                    href="/subscribe"
                    className="ui-text-sm inline-flex min-h-[40px] items-center gap-1.5 rounded-md bg-zinc-900 px-3 font-medium text-white transition-colors hover:bg-zinc-800 active:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:active:bg-zinc-300"
                  >
                    <PlusIcon className="h-4 w-4" />
                    <span className="hidden sm:inline">Subscribe</span>
                  </ClientLink>

                  {/* User menu */}
                  <div className="relative">
                    <button
                      onClick={() => setUserMenuOpen(!userMenuOpen)}
                      className="ui-text-sm flex min-h-[40px] items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 text-zinc-700 transition-colors hover:bg-zinc-50 active:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
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
                        <div className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                          <ClientLink
                            href="/settings"
                            onNavigate={() => setUserMenuOpen(false)}
                            className="ui-text-sm flex min-h-[44px] items-center px-4 text-zinc-700 hover:bg-zinc-100 active:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
                          >
                            Settings
                          </ClientLink>
                          <ClientLink
                            href="/settings/sessions"
                            onNavigate={() => setUserMenuOpen(false)}
                            className="ui-text-sm flex min-h-[44px] items-center px-4 text-zinc-700 hover:bg-zinc-100 active:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
                          >
                            Sessions
                          </ClientLink>
                          <hr className="my-1 border-zinc-200 dark:border-zinc-700" />
                          <button
                            onClick={() => {
                              setUserMenuOpen(false);
                              handleLogout();
                            }}
                            disabled={logoutMutation.isPending}
                            className="ui-text-sm flex min-h-[44px] w-full items-center px-4 text-left text-zinc-700 hover:bg-zinc-100 active:bg-zinc-200 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
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
              <MainScrollContainer className="flex-1 overflow-y-auto bg-zinc-50 dark:bg-zinc-950">
                <AppRouter />
              </MainScrollContainer>
            </LayoutShell>
          </ScrollContainerProvider>
        </KeyboardShortcutsProvider>
      </RealtimeProvider>
    </AppearanceProvider>
  );
}

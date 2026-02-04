/**
 * App Layout Content
 *
 * Client component with the main application layout UI.
 * Includes sidebar navigation and header.
 */

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { handleClientNav } from "@/lib/navigation";
import { Toaster, toast } from "sonner";
import { Sidebar } from "@/components/layout/Sidebar";
import { UserEmail } from "@/components/layout/UserEmail";
import { RealtimeProvider } from "@/components/layout/RealtimeProvider";
import { OfflineBanner } from "@/components/layout/OfflineBanner";
import {
  ScrollContainerProvider,
  MainScrollContainer,
} from "@/components/layout/ScrollContainerContext";
import { KeyboardShortcutsProvider } from "@/components/keyboard";
import { AppRouter } from "@/components/app";
import { trpc } from "@/lib/trpc/client";
import { AppearanceProvider } from "@/lib/appearance";
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
            <div className="flex h-screen bg-zinc-50 dark:bg-zinc-950">
              {/* Mobile sidebar overlay */}
              {sidebarOpen && (
                <div
                  className="fixed inset-0 z-40 bg-black/50 lg:hidden"
                  onClick={() => setSidebarOpen(false)}
                />
              )}

              {/* Sidebar */}
              <aside
                className={`fixed inset-y-0 left-0 z-50 w-64 transform border-r border-zinc-200 bg-white transition-transform duration-200 ease-in-out lg:static lg:translate-x-0 dark:border-zinc-800 dark:bg-zinc-900 ${
                  sidebarOpen ? "translate-x-0" : "-translate-x-full"
                }`}
              >
                {/* Sidebar header */}
                <div className="flex h-14 items-center justify-between border-b border-zinc-200 px-4 dark:border-zinc-800">
                  <Link
                    href="/all"
                    onClick={(e) => handleClientNav(e, "/all")}
                    className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50"
                  >
                    Lion Reader
                  </Link>
                  <button
                    onClick={() => setSidebarOpen(false)}
                    className="flex h-10 w-10 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 active:bg-zinc-200 lg:hidden dark:text-zinc-400 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
                    aria-label="Close navigation menu"
                  >
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
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
                <header className="flex h-14 items-center justify-between border-b border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-zinc-900">
                  {/* Mobile menu button */}
                  <button
                    onClick={() => setSidebarOpen(true)}
                    className="flex h-10 w-10 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 active:bg-zinc-200 lg:hidden dark:text-zinc-400 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
                    aria-label="Open navigation menu"
                  >
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 6h16M4 12h16M4 18h16"
                      />
                    </svg>
                  </button>

                  {/* Spacer for desktop */}
                  <div className="hidden lg:block" />

                  {/* Right side actions */}
                  <div className="flex items-center gap-2">
                    {/* Subscribe button */}
                    <Link
                      href="/subscribe"
                      onClick={(e) => handleClientNav(e, "/subscribe")}
                      className="ui-text-sm inline-flex min-h-[40px] items-center gap-1.5 rounded-md bg-zinc-900 px-3 font-medium text-white transition-colors hover:bg-zinc-800 active:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:active:bg-zinc-300"
                    >
                      <svg
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 4v16m8-8H4"
                        />
                      </svg>
                      <span className="hidden sm:inline">Subscribe</span>
                    </Link>

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
                          <svg
                            className="h-5 w-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
                            />
                          </svg>
                        </span>
                        <svg
                          className={`h-4 w-4 transition-transform ${userMenuOpen ? "rotate-180" : ""}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 9l-7 7-7-7"
                          />
                        </svg>
                      </button>

                      {/* Dropdown menu */}
                      {userMenuOpen && (
                        <>
                          <div
                            className="fixed inset-0 z-10"
                            onClick={() => setUserMenuOpen(false)}
                          />
                          <div className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                            <Link
                              href="/settings"
                              onClick={(e) =>
                                handleClientNav(e, "/settings", () => setUserMenuOpen(false))
                              }
                              className="ui-text-sm flex min-h-[44px] items-center px-4 text-zinc-700 hover:bg-zinc-100 active:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
                            >
                              Settings
                            </Link>
                            <Link
                              href="/settings/sessions"
                              onClick={(e) =>
                                handleClientNav(e, "/settings/sessions", () =>
                                  setUserMenuOpen(false)
                                )
                              }
                              className="ui-text-sm flex min-h-[44px] items-center px-4 text-zinc-700 hover:bg-zinc-100 active:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
                            >
                              Sessions
                            </Link>
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
                </header>

                {/* Offline banner */}
                <OfflineBanner />

                {/* Main content */}
                <MainScrollContainer className="flex-1 overflow-y-auto bg-zinc-50 dark:bg-zinc-950">
                  <AppRouter />
                </MainScrollContainer>
              </div>
            </div>
          </ScrollContainerProvider>
        </KeyboardShortcutsProvider>
      </RealtimeProvider>
    </AppearanceProvider>
  );
}

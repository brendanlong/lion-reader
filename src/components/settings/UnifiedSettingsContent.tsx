/**
 * UnifiedSettingsContent Component
 *
 * Unified settings page that reads usePathname() to determine which
 * settings section to render. This enables client-side navigation
 * via pushState without triggering SSR.
 *
 * Includes the settings layout (sidebar navigation) and switches
 * content based on the current pathname.
 */

"use client";

import { Suspense, lazy } from "react";
import { usePathname } from "next/navigation";
import { ClientLink } from "@/components/ui";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

// Settings page components - lazy loaded for code splitting
const AccountSettingsContent = lazy(() => import("./pages/AccountSettingsContent"));
const AppearanceSettingsContent = lazy(() =>
  import("./AppearanceSettings").then((m) => ({ default: m.AppearanceSettings }))
);
const SessionsSettingsContent = lazy(() => import("./pages/SessionsSettingsContent"));
const ApiTokensSettingsContent = lazy(() => import("./pages/ApiTokensSettingsContent"));
const IntegrationsSettingsContent = lazy(() => import("./pages/IntegrationsSettingsContent"));
const EmailSettingsContent = lazy(() => import("./pages/EmailSettingsContent"));
const BlockedSendersSettingsContent = lazy(() => import("./pages/BlockedSendersSettingsContent"));
const BrokenFeedsSettingsContent = lazy(() => import("./pages/BrokenFeedsSettingsContent"));
const FeedStatsSettingsContent = lazy(() => import("./pages/FeedStatsSettingsContent"));

const settingsLinks = [
  { href: "/settings", label: "Account" },
  { href: "/settings/appearance", label: "Appearance" },
  { href: "/settings/sessions", label: "Sessions" },
  { href: "/settings/api-tokens", label: "API Tokens" },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/email", label: "Email Subscriptions" },
  { href: "/settings/blocked-senders", label: "Blocked Senders" },
  { href: "/settings/broken-feeds", label: "Broken Feeds" },
  { href: "/settings/feed-stats", label: "Feed Stats" },
];

/**
 * Loading skeleton for settings content.
 */
function SettingsContentSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders the appropriate settings content based on pathname.
 */
function SettingsContentRouter() {
  const pathname = usePathname();

  // Match exact paths
  switch (pathname) {
    case "/settings":
      return <AccountSettingsContent />;
    case "/settings/appearance":
      return <AppearanceSettingsContent />;
    case "/settings/sessions":
      return <SessionsSettingsContent />;
    case "/settings/api-tokens":
      return <ApiTokensSettingsContent />;
    case "/settings/integrations":
      return <IntegrationsSettingsContent />;
    case "/settings/email":
      return <EmailSettingsContent />;
    case "/settings/blocked-senders":
      return <BlockedSendersSettingsContent />;
    case "/settings/broken-feeds":
      return <BrokenFeedsSettingsContent />;
    case "/settings/feed-stats":
      return <FeedStatsSettingsContent />;
    default:
      // Default to account settings for unknown paths
      return <AccountSettingsContent />;
  }
}

/**
 * Unified settings content with layout and pathname-based routing.
 */
export function UnifiedSettingsContent() {
  const pathname = usePathname();

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <ClientLink
          href="/all"
          className="ui-text-sm mb-4 inline-flex items-center text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          <svg className="mr-1 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          Back to feeds
        </ClientLink>
        <h1 className="ui-text-2xl font-bold text-zinc-900 dark:text-zinc-50">Settings</h1>
      </div>

      <div className="flex flex-col gap-8 md:flex-row">
        {/* Sidebar Navigation */}
        <nav className="w-full shrink-0 md:w-48">
          <ul className="flex gap-1 md:flex-col">
            {settingsLinks.map((link) => {
              const isActive = pathname === link.href;
              return (
                <li key={link.href}>
                  <ClientLink
                    href={link.href}
                    className={`ui-text-sm block rounded-md px-3 py-2 font-medium transition-colors ${
                      isActive
                        ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-50"
                        : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-50"
                    }`}
                  >
                    {link.label}
                  </ClientLink>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Main Content */}
        <div className="min-w-0 flex-1">
          <ErrorBoundary message="Failed to load settings">
            <Suspense fallback={<SettingsContentSkeleton />}>
              <SettingsContentRouter />
            </Suspense>
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

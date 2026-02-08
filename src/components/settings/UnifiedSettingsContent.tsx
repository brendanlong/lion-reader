/**
 * UnifiedSettingsContent Component
 *
 * Unified settings page that reads usePathname() to determine which
 * settings section to render. This enables client-side navigation
 * via pushState without triggering SSR.
 *
 * Includes the settings layout (sidebar navigation) and switches
 * content based on the current pathname.
 *
 * Settings pages are NOT lazy-loaded so that static content (titles,
 * descriptions) can render immediately while data loads. The settings
 * bundle is small enough that this tradeoff is worthwhile for better UX.
 */

"use client";

import { usePathname } from "next/navigation";
import { ClientLink } from "@/components/ui/client-link";
import { ChevronLeftIcon } from "@/components/ui/icon-button";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

// Settings page components - directly imported (not lazy) so static content
// like titles renders immediately while data loads
import AccountSettingsContent from "./pages/AccountSettingsContent";
import { AppearanceSettings as AppearanceSettingsContent } from "./AppearanceSettings";
import SubscriptionsSettingsContent from "./pages/SubscriptionsSettingsContent";
import EmailSettingsContent from "./pages/EmailSettingsContent";
import AiSettingsContent from "./pages/AiSettingsContent";
import IntegrationsSettingsContent from "./pages/IntegrationsSettingsContent";
import FeedHealthSettingsContent from "./pages/FeedHealthSettingsContent";
import SessionsSettingsContent from "./pages/SessionsSettingsContent";

const settingsLinks = [
  { href: "/settings", label: "Account" },
  { href: "/settings/appearance", label: "Appearance" },
  { href: "/settings/subscriptions", label: "Subscriptions" },
  { href: "/settings/email", label: "Email" },
  { href: "/settings/ai", label: "AI & Narration" },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/feed-health", label: "Feed Health" },
  { href: "/settings/sessions", label: "Sessions" },
];

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
    case "/settings/subscriptions":
      return <SubscriptionsSettingsContent />;
    case "/settings/email":
      return <EmailSettingsContent />;
    case "/settings/ai":
      return <AiSettingsContent />;
    case "/settings/integrations":
      return <IntegrationsSettingsContent />;
    case "/settings/feed-health":
      return <FeedHealthSettingsContent />;
    case "/settings/sessions":
      return <SessionsSettingsContent />;
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
          <ChevronLeftIcon className="mr-1 h-4 w-4" />
          Back to feeds
        </ClientLink>
        <h1 className="ui-text-2xl font-bold text-zinc-900 dark:text-zinc-50">Settings</h1>
      </div>

      <div className="flex flex-col gap-8 md:flex-row">
        {/* Sidebar Navigation */}
        <nav className="w-full shrink-0 md:w-48">
          <ul className="flex flex-wrap gap-1 overflow-x-auto md:flex-col md:flex-nowrap md:overflow-x-visible">
            {settingsLinks.map((link) => {
              const isActive = pathname === link.href;
              return (
                <li key={link.href}>
                  <ClientLink
                    href={link.href}
                    className={`ui-text-sm block rounded-md px-3 py-2 font-medium whitespace-nowrap transition-colors ${
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
            <SettingsContentRouter />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

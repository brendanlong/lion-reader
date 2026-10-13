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
 * Each settings page is its own chunk, so opening settings doesn't download
 * every page's dependencies (narration voices, OPML, QR codes, ...). The
 * sidebar renders immediately; the page shows a skeleton until its chunk loads.
 */

"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { ClientLink } from "@/components/ui/client-link";
import { ChevronLeftIcon } from "@/components/ui/icons";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

import { SettingsListSkeleton } from "./SettingsListSkeleton";

function SettingsPageSkeleton() {
  return (
    <div className="space-y-6">
      <SettingsListSkeleton variant="card" count={2} height="h-40" />
    </div>
  );
}

const AccountSettingsContent = dynamic(() => import("./pages/AccountSettingsContent"), {
  loading: SettingsPageSkeleton,
});
const AppearanceSettingsContent = dynamic(
  () => import("./AppearanceSettings").then((m) => m.AppearanceSettings),
  { loading: SettingsPageSkeleton }
);
const SubscriptionsSettingsContent = dynamic(() => import("./pages/SubscriptionsSettingsContent"), {
  loading: SettingsPageSkeleton,
});
const EmailSettingsContent = dynamic(() => import("./pages/EmailSettingsContent"), {
  loading: SettingsPageSkeleton,
});
const AiSettingsContent = dynamic(() => import("./pages/AiSettingsContent"), {
  loading: SettingsPageSkeleton,
});
const IntegrationsSettingsContent = dynamic(() => import("./pages/IntegrationsSettingsContent"), {
  loading: SettingsPageSkeleton,
});
const FeedHealthSettingsContent = dynamic(() => import("./pages/FeedHealthSettingsContent"), {
  loading: SettingsPageSkeleton,
});
const SessionsSettingsContent = dynamic(() => import("./pages/SessionsSettingsContent"), {
  loading: SettingsPageSkeleton,
});
const ConnectedAppsSettingsContent = dynamic(() => import("./pages/ConnectedAppsSettingsContent"), {
  loading: SettingsPageSkeleton,
});
const DeleteAccountSettingsContent = dynamic(() => import("./pages/DeleteAccountSettingsContent"), {
  loading: SettingsPageSkeleton,
});

const settingsLinks = [
  { href: "/settings", label: "Account" },
  { href: "/settings/appearance", label: "Appearance" },
  { href: "/settings/subscriptions", label: "Subscriptions" },
  { href: "/settings/email", label: "Email" },
  { href: "/settings/ai", label: "AI & Narration" },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/feed-health", label: "Feed Health" },
  { href: "/settings/sessions", label: "Sessions" },
  { href: "/settings/connected-apps", label: "Connected Apps" },
  { href: "/settings/delete-account", label: "Delete Account" },
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
    case "/settings/connected-apps":
      return <ConnectedAppsSettingsContent />;
    case "/settings/delete-account":
      return <DeleteAccountSettingsContent />;
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
          className="ui-text-sm text-muted hover:text-body mb-4 inline-flex items-center"
        >
          <ChevronLeftIcon className="mr-1 h-4 w-4" />
          Back to feeds
        </ClientLink>
        <h1 className="ui-text-2xl text-body font-bold">Settings</h1>
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
                        ? "bg-primary-solid text-primary-solid-foreground"
                        : "text-muted hover:bg-surface-muted hover:text-body"
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

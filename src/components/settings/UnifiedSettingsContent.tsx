/**
 * UnifiedSettingsContent Component
 *
 * Unified settings page that reads usePathname() to determine which
 * settings section to render. This enables client-side navigation
 * via pushState without triggering SSR.
 *
 * Includes the settings layout (search bar, sidebar navigation) and switches
 * content based on the current pathname, or shows search results while there
 * is a search query.
 *
 * Each settings page is its own chunk, so opening settings doesn't download
 * every page's dependencies (narration voices, OPML, QR codes, ...). The
 * sidebar renders immediately; the page shows a skeleton until its chunk loads.
 */

"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { ClientLink } from "@/components/ui/client-link";
import { ChevronLeftIcon, CloseIcon, SearchIcon } from "@/components/ui/icons";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

import { SettingsListSkeleton } from "./SettingsListSkeleton";
import { SettingsSearchResults } from "./SettingsSearchResults";
import { SETTINGS_PAGES } from "./settings-search";

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

const ACTIVE_LINK_CLASSES = "bg-primary-solid text-primary-solid-foreground";

function SettingsSearchBar({
  query,
  onChange,
}: {
  query: string;
  onChange: (query: string) => void;
}) {
  return (
    <div className="relative w-full md:max-w-xs" role="search">
      <SearchIcon className="text-faint pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
      <input
        type="search"
        enterKeyHint="search"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onChange("");
          }
        }}
        placeholder="Search settings"
        aria-label="Search settings"
        className="ui-text-sm bg-surface text-body placeholder:text-faint border-edge-input block w-full rounded-md border py-2 pr-10 pl-9 [&::-webkit-search-cancel-button]:hidden"
      />
      {query !== "" && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          title="Clear search"
          className="text-muted hover:text-body absolute top-1/2 right-1 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md transition-colors"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      )}
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
  const [query, setQuery] = useState("");
  const isSearching = query.trim() !== "";

  // Leaving for a settings page (sidebar, a result's page link, back/forward)
  // ends the search — render-time state adjustment, not an effect.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setQuery("");
  }

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
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <h1 className="ui-text-2xl text-body font-bold">Settings</h1>
          <SettingsSearchBar query={query} onChange={setQuery} />
        </div>
      </div>

      <div className="flex flex-col gap-8 md:flex-row">
        {/* Sidebar Navigation */}
        <nav className="w-full shrink-0 md:w-48">
          <ul className="flex flex-wrap gap-1 overflow-x-auto md:flex-col md:flex-nowrap md:overflow-x-visible">
            {isSearching && (
              <li>
                <span
                  aria-current="page"
                  className={`ui-text-sm block rounded-md px-3 py-2 font-medium whitespace-nowrap ${ACTIVE_LINK_CLASSES}`}
                >
                  Search results
                </span>
              </li>
            )}
            {SETTINGS_PAGES.map((link) => {
              const isActive = !isSearching && pathname === link.href;
              return (
                <li key={link.href}>
                  <ClientLink
                    href={link.href}
                    aria-current={isActive ? "page" : undefined}
                    onNavigate={() => setQuery("")}
                    className={`ui-text-sm block rounded-md px-3 py-2 font-medium whitespace-nowrap transition-colors ${
                      isActive
                        ? ACTIVE_LINK_CLASSES
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
            {isSearching ? (
              <SettingsSearchResults query={query} onNavigate={() => setQuery("")} />
            ) : (
              <SettingsContentRouter />
            )}
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

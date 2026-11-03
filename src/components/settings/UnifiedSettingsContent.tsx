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
 * Pages are imported statically, not as per-page chunks: a lazy page would
 * suspend on each tab's first visit (see "Suspense vs. inline loading" in
 * src/CLAUDE.md). AppRouter splits Settings as a whole from the entry lists.
 */

"use client";

import { useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ClientLink } from "@/components/ui/client-link";
import { ChevronLeftIcon, CloseIcon, SearchIcon } from "@/components/ui/icons";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

import AccountSettingsContent from "./pages/AccountSettingsContent";
import { AppearanceSettings as AppearanceSettingsContent } from "./AppearanceSettings";
import ReadingSettingsContent from "./pages/ReadingSettingsContent";
import SubscriptionsSettingsContent from "./pages/SubscriptionsSettingsContent";
import EmailSettingsContent from "./pages/EmailSettingsContent";
import AiSettingsContent from "./pages/AiSettingsContent";
import IntegrationsSettingsContent from "./pages/IntegrationsSettingsContent";
import FeedHealthSettingsContent from "./pages/FeedHealthSettingsContent";
import SecuritySettingsContent from "./pages/SecuritySettingsContent";
import { AboutSection as AboutSettingsContent } from "./AboutSection";
import { SettingsSearchResults } from "./SettingsSearchResults";
import { SETTINGS_PAGES } from "./settings-search";

const ACTIVE_LINK_CLASSES = "bg-primary-solid text-primary-solid-foreground";

function SettingsSearchBar({
  query,
  onChange,
}: {
  query: string;
  onChange: (query: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="relative w-full md:max-w-xs" role="search">
      <SearchIcon className="text-faint pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
      <input
        ref={inputRef}
        type="search"
        enterKeyHint="search"
        value={query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query !== "") {
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
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
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
    case "/settings/reading":
      return <ReadingSettingsContent />;
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
    case "/settings/security":
      return <SecuritySettingsContent />;
    case "/settings/about":
      return <AboutSettingsContent />;
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
    <div className="mx-auto max-w-4xl px-4 py-6 md:py-8">
      {/* Header */}
      <div className="mb-6 md:mb-8">
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

      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        {/* Sidebar Navigation */}
        <nav className="w-full shrink-0 md:w-48">
          {/* Phones wrap the tabs so every one stays visible. */}
          <ul className="flex flex-wrap gap-x-1 md:flex-col md:flex-nowrap md:gap-1">
            {isSearching && (
              <li>
                <span
                  aria-current="page"
                  className={`ui-text-sm flex min-h-11 items-center rounded-md px-3 font-medium whitespace-nowrap md:block md:min-h-0 md:py-2 ${ACTIVE_LINK_CLASSES}`}
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
                    className={`ui-text-sm flex min-h-11 items-center rounded-md px-3 font-medium whitespace-nowrap transition-colors md:block md:min-h-0 md:py-2 ${
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
          <ErrorBoundary key={isSearching ? "search" : pathname} message="Failed to load settings">
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

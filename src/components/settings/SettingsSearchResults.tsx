/**
 * SettingsSearchResults Component
 *
 * The "Search results" settings tab: the live sections matching the query,
 * best match first, each labeled with the page it lives on. Sections load
 * lazily, so only the matching sections' modules are downloaded.
 */

"use client";

import { useDeferredValue, useMemo, type ComponentType } from "react";
import dynamic from "next/dynamic";
import { trpc } from "@/lib/trpc/client";
import { ClientLink } from "@/components/ui/client-link";
import { ChevronRightIcon } from "@/components/ui/icons";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { SettingsListSkeleton } from "./SettingsListSkeleton";
import {
  MIN_QUERY_LENGTH,
  SETTINGS_PAGE_LABELS,
  searchSettings,
  type SettingsSearchResult,
  type SettingsSectionId,
} from "./settings-search";

function SectionSkeleton() {
  return <SettingsListSkeleton variant="card" count={1} height="h-32" />;
}

const SECTION_COMPONENTS: Record<SettingsSectionId, ComponentType> = {
  "account-info": dynamic(
    () => import("./pages/AccountSettingsContent").then((m) => m.AccountInfoSection),
    { loading: SectionSkeleton }
  ),
  "linked-accounts": dynamic(() => import("./LinkedAccounts").then((m) => m.LinkedAccounts), {
    loading: SectionSkeleton,
  }),
  password: dynamic(() => import("./pages/AccountSettingsContent").then((m) => m.PasswordSection), {
    loading: SectionSkeleton,
  }),
  "keyboard-shortcuts": dynamic(
    () => import("./KeyboardShortcutsSettings").then((m) => m.KeyboardShortcutsSettings),
    { loading: SectionSkeleton }
  ),
  "privacy-legal": dynamic(
    () => import("./pages/AccountSettingsContent").then((m) => m.PrivacyLegalSection),
    { loading: SectionSkeleton }
  ),
  about: dynamic(() => import("./AboutSection").then((m) => m.AboutSection), {
    loading: SectionSkeleton,
  }),
  theme: dynamic(() => import("./AppearanceSettings").then((m) => m.ThemeSettings), {
    loading: SectionSkeleton,
  }),
  "article-text": dynamic(() => import("./AppearanceSettings").then((m) => m.ArticleTextSettings), {
    loading: SectionSkeleton,
  }),
  "entry-list": dynamic(() => import("./AppearanceSettings").then((m) => m.EntryListSettings), {
    loading: SectionSkeleton,
  }),
  tags: dynamic(() => import("./TagManagement").then((m) => m.TagManagement), {
    loading: SectionSkeleton,
  }),
  "import-export": dynamic(() => import("./OpmlImportExport").then((m) => m.OpmlImportExport), {
    loading: SectionSkeleton,
  }),
  "ingest-addresses": dynamic(
    () => import("./pages/EmailSettingsContent").then((m) => m.IngestAddressesSection),
    { loading: SectionSkeleton }
  ),
  spam: dynamic(() => import("./pages/EmailSettingsContent").then((m) => m.SpamPreferenceSection), {
    loading: SectionSkeleton,
  }),
  "blocked-senders": dynamic(() => import("./pages/BlockedSendersSettingsContent"), {
    loading: SectionSkeleton,
  }),
  "ai-provider-keys": dynamic(
    () => import("./ApiKeySettings").then((m) => m.AiProviderKeySettings),
    { loading: SectionSkeleton }
  ),
  summaries: dynamic(() => import("./ApiKeySettings").then((m) => m.SummarizationSettings), {
    loading: SectionSkeleton,
  }),
  "ai-text-processing": dynamic(
    () => import("./ApiKeySettings").then((m) => m.NarrationAiSettings),
    { loading: SectionSkeleton }
  ),
  narration: dynamic(
    () => import("@/components/narration/NarrationSettings").then((m) => m.NarrationSettings),
    { loading: SectionSkeleton }
  ),
  "save-to-lion-reader": dynamic(
    () => import("./BookmarkletSettings").then((m) => m.BookmarkletSettings),
    { loading: SectionSkeleton }
  ),
  "google-reader-api": dynamic(
    () => import("./GoogleReaderApiSettings").then((m) => m.GoogleReaderApiSettings),
    { loading: SectionSkeleton }
  ),
  "wallabag-api": dynamic(
    () => import("./WallabagApiSettings").then((m) => m.WallabagApiSettings),
    { loading: SectionSkeleton }
  ),
  "ai-integrations": dynamic(
    () => import("./IntegrationsSettings").then((m) => m.IntegrationsSettings),
    { loading: SectionSkeleton }
  ),
  "discord-bot": dynamic(() => import("./DiscordBotSettings").then((m) => m.DiscordBotSettings), {
    loading: SectionSkeleton,
  }),
  "api-tokens": dynamic(() => import("./pages/ApiTokensSettingsContent"), {
    loading: SectionSkeleton,
  }),
  "broken-feeds": dynamic(() => import("./pages/BrokenFeedsSettingsContent"), {
    loading: SectionSkeleton,
  }),
  "feed-statistics": dynamic(() => import("./pages/FeedStatsSettingsContent"), {
    loading: SectionSkeleton,
  }),
  sessions: dynamic(() => import("./pages/SessionsSettingsContent"), { loading: SectionSkeleton }),
  "connected-apps": dynamic(() => import("./pages/ConnectedAppsSettingsContent"), {
    loading: SectionSkeleton,
  }),
  "delete-account": dynamic(() => import("./pages/DeleteAccountSettingsContent"), {
    loading: SectionSkeleton,
  }),
};

function SearchResult({
  result,
  onNavigate,
}: {
  result: SettingsSearchResult;
  onNavigate: () => void;
}) {
  const Section = SECTION_COMPONENTS[result.id];
  const pageLabel = SETTINGS_PAGE_LABELS.get(result.page);
  return (
    <div>
      <ClientLink
        href={result.page}
        onNavigate={onNavigate}
        aria-label={`Open ${pageLabel} settings`}
        className="ui-text-sm text-muted hover:text-body mb-1 inline-flex min-h-11 items-center gap-0.5"
      >
        {pageLabel}
        <ChevronRightIcon className="h-3.5 w-3.5" />
      </ClientLink>
      <ErrorBoundary message={`Failed to load ${result.title}`}>
        <Section />
      </ErrorBoundary>
    </div>
  );
}

interface SettingsSearchResultsProps {
  query: string;
  /** Called when the user follows a result to its settings page. */
  onNavigate: () => void;
}

export function SettingsSearchResults({ query, onNavigate }: SettingsSearchResultsProps) {
  const preferencesQuery = trpc.users["me.preferences"].useQuery();
  const canConfigureApiKeys = preferencesQuery.data?.canConfigureApiKeys ?? false;

  // Typing stays responsive while a new set of sections mounts.
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(
    () => searchSettings(deferredQuery, { canConfigureApiKeys }),
    [deferredQuery, canConfigureApiKeys]
  );

  const trimmed = deferredQuery.trim();
  const status =
    trimmed.length < MIN_QUERY_LENGTH
      ? "Keep typing to search settings."
      : results.length === 0
        ? `No settings match \u201c${trimmed}\u201d.`
        : `${results.length} ${results.length === 1 ? "setting" : "settings"} found`;

  return (
    <div>
      <p
        role="status"
        className={results.length === 0 ? "ui-text-sm text-muted py-8 text-center" : "sr-only"}
      >
        {status}
      </p>
      <div className="space-y-8">
        {results.map((result) => (
          <SearchResult key={result.id} result={result} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}

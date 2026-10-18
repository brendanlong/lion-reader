/**
 * SettingsSearchResults Component
 *
 * The "Search results" settings tab: the live sections matching the query,
 * best match first, each labeled with the page it lives on. Each section is
 * its own chunk, so only the matching sections' code is downloaded.
 */

"use client";

import { useMemo, type ComponentType } from "react";
import dynamic from "next/dynamic";
import { trpc } from "@/lib/trpc/client";
import { ClientLink } from "@/components/ui/client-link";
import { ChevronRightIcon } from "@/components/ui/icons";
import { SettingsListSkeleton } from "./SettingsListSkeleton";
import {
  SETTINGS_PAGES,
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

const PAGE_LABELS = new Map<string, string>(SETTINGS_PAGES.map((p) => [p.href, p.label]));

function SearchResult({
  result,
  onNavigate,
}: {
  result: SettingsSearchResult;
  onNavigate: () => void;
}) {
  const Section = SECTION_COMPONENTS[result.id];
  return (
    <div>
      <ClientLink
        href={result.page}
        onNavigate={onNavigate}
        className="ui-text-xs text-muted hover:text-body mb-1 inline-flex items-center gap-0.5"
      >
        {PAGE_LABELS.get(result.page)}
        <ChevronRightIcon className="h-3 w-3" />
      </ClientLink>
      <Section />
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

  const results = useMemo(
    () => searchSettings(query, { canConfigureApiKeys }),
    [query, canConfigureApiKeys]
  );

  if (results.length === 0) {
    return (
      <p className="ui-text-sm text-muted py-8 text-center">
        No settings match &ldquo;{query.trim()}&rdquo;.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {results.map((result) => (
        <SearchResult key={result.id} result={result} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

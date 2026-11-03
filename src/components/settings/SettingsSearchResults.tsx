/**
 * SettingsSearchResults Component
 *
 * The "Search results" settings tab: the live sections matching the query,
 * best match first, each labeled with the page it lives on.
 */

"use client";

import { useDeferredValue, useMemo, type ComponentType } from "react";
import { trpc } from "@/lib/trpc/client";
import { ClientLink } from "@/components/ui/client-link";
import { ChevronRightIcon } from "@/components/ui/icons";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { AccountInfoSection, PasswordSection, PlanSection } from "./pages/AccountSettingsContent";
import { LinkedAccounts } from "./LinkedAccounts";
import { KeyboardShortcutsSettings } from "./KeyboardShortcutsSettings";
import { AboutSection } from "./AboutSection";
import { ArticleTextSettings, EntryListSettings, ThemeSettings } from "./AppearanceSettings";
import { MarkReadSettings } from "./MarkReadSettings";
import { TagManagement } from "./TagManagement";
import { OpmlImportExport } from "./OpmlImportExport";
import { IngestAddressesSection, SpamPreferenceSection } from "./pages/EmailSettingsContent";
import BlockedSendersSettingsContent from "./pages/BlockedSendersSettingsContent";
import { AiProviderKeySettings, SummarizationSettings } from "./ApiKeySettings";
import { NarrationSettings } from "@/components/narration/NarrationSettings";
import { BookmarkletSettings } from "./BookmarkletSettings";
import { GoogleReaderApiSettings } from "./GoogleReaderApiSettings";
import { WallabagApiSettings } from "./WallabagApiSettings";
import { IntegrationsSettings } from "./IntegrationsSettings";
import { DiscordBotSettings } from "./DiscordBotSettings";
import ApiTokensSettingsContent from "./pages/ApiTokensSettingsContent";
import BrokenFeedsSettingsContent from "./pages/BrokenFeedsSettingsContent";
import FeedStatsSettingsContent from "./pages/FeedStatsSettingsContent";
import SessionsSettingsContent from "./pages/SessionsSettingsContent";
import ConnectedAppsSettingsContent from "./pages/ConnectedAppsSettingsContent";
import { DeleteAccountSection } from "./DeleteAccountSection";
import {
  MIN_QUERY_LENGTH,
  SETTINGS_PAGE_LABELS,
  searchSettings,
  type SettingsSearchResult,
  type SettingsSectionId,
} from "./settings-search";

const SECTION_COMPONENTS: Record<SettingsSectionId, ComponentType> = {
  "account-info": AccountInfoSection,
  plan: PlanSection,
  "linked-accounts": LinkedAccounts,
  password: PasswordSection,
  "keyboard-shortcuts": KeyboardShortcutsSettings,
  about: AboutSection,
  theme: ThemeSettings,
  "article-text": ArticleTextSettings,
  "entry-list": EntryListSettings,
  "mark-read": MarkReadSettings,
  tags: TagManagement,
  "import-export": OpmlImportExport,
  "ingest-addresses": IngestAddressesSection,
  spam: SpamPreferenceSection,
  "blocked-senders": BlockedSendersSettingsContent,
  "ai-provider-keys": AiProviderKeySettings,
  summaries: SummarizationSettings,
  narration: NarrationSettings,
  "save-to-lion-reader": BookmarkletSettings,
  "google-reader-api": GoogleReaderApiSettings,
  "wallabag-api": WallabagApiSettings,
  "ai-integrations": IntegrationsSettings,
  "discord-bot": DiscordBotSettings,
  "api-tokens": ApiTokensSettingsContent,
  "broken-feeds": BrokenFeedsSettingsContent,
  "feed-statistics": FeedStatsSettingsContent,
  sessions: SessionsSettingsContent,
  "connected-apps": ConnectedAppsSettingsContent,
  "delete-account": DeleteAccountSection,
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

/**
 * AI & Narration Settings Content
 *
 * Page for AI-powered features: API keys for text processing and summarization,
 * and text-to-speech narration configuration.
 */

"use client";

import { trpc } from "@/lib/trpc/client";
import {
  AiProviderKeySettings,
  SummarizationSettings,
  NarrationAiSettings,
} from "@/components/settings/ApiKeySettings";
import { NarrationSettings } from "@/components/narration/NarrationSettings";

function ApiKeySettingsSections() {
  const preferencesQuery = trpc.users["me.preferences"].useQuery();
  const canConfigure = preferencesQuery.data?.canConfigureApiKeys ?? false;

  if (preferencesQuery.isLoading || !canConfigure) return null;

  return (
    <>
      {/* Provider API keys */}
      <AiProviderKeySettings />

      {/* Summaries (model, max words, custom prompt) */}
      <SummarizationSettings />

      {/* Narration text processing model (JSON-mode providers) */}
      <NarrationAiSettings />
    </>
  );
}

export default function AiSettingsContent() {
  return (
    <div className="space-y-8">
      {/* AI API key settings - only shown when encryption is configured */}
      <ApiKeySettingsSections />

      {/* Narration Section */}
      <NarrationSettings />
    </div>
  );
}

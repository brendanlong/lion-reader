/**
 * AI & Narration Settings Content
 *
 * Page for AI-powered features: API keys for text processing and summarization,
 * and text-to-speech narration configuration.
 */

"use client";

import { trpc } from "@/lib/trpc/client";
import {
  GroqApiKeySettings,
  SummarizationApiKeySettings,
} from "@/components/settings/ApiKeySettings";
// Import directly from file to avoid barrel export pulling in piper-tts-web
import { NarrationSettings } from "@/components/narration/NarrationSettings";

function ApiKeySettingsSections() {
  const preferencesQuery = trpc.users["me.preferences"].useQuery();
  const canConfigure = preferencesQuery.data?.canConfigureApiKeys ?? false;

  if (preferencesQuery.isLoading || !canConfigure) return null;

  return (
    <>
      {/* AI Text Processing (Groq API key) */}
      <GroqApiKeySettings />

      {/* Summaries (Anthropic API key + model) */}
      <SummarizationApiKeySettings />
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

/**
 * API Key Settings Components
 *
 * Settings sections for user-configured AI provider API keys and the model
 * settings that build on them.
 */

"use client";

import { useCallback } from "react";
import { trpc } from "@/lib/trpc/client";
import { usePreferenceMutation } from "@/lib/hooks/usePreferenceMutation";
import { AlertIcon, CheckIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { TextLink } from "@/components/ui/text-link";
import { InlineCode } from "@/components/ui/inline-code";
import { normalizeModelRef } from "@/lib/ai/model-ref";
import {
  AI_PROVIDER_INFO,
  AI_PROVIDERS,
  aiProviderNames,
  SPEECH_PROVIDERS,
  TEXT_AI_PROVIDERS,
  type AiProvider,
} from "@/lib/ai/providers";
import {
  DEFAULT_SUMMARIZATION_MODEL,
  DEFAULT_SUMMARIZATION_MAX_WORDS,
  SUGGESTED_SUMMARIZATION_MODELS,
} from "@/lib/summarization/constants";
import {
  DEFAULT_NARRATION_MODEL,
  NARRATION_PROVIDERS,
  SUGGESTED_NARRATION_MODELS,
} from "@/lib/narration/constants";
import type { PickerModel } from "@/lib/ai/model-picker";
import { EditablePreferenceField } from "./EditablePreferenceField";
import { ModelPicker } from "./ModelPicker";
import { SettingsSection } from "./SettingsSection";

const AI_FEATURES = [
  { name: "summaries", providers: TEXT_AI_PROVIDERS },
  { name: "narration", providers: NARRATION_PROVIDERS },
  { name: "cloud voices", providers: SPEECH_PROVIDERS },
] as const satisfies readonly { name: string; providers: readonly AiProvider[] }[];

/** "summaries, narration" */
function providerFeatures(provider: AiProvider): string {
  return AI_FEATURES.filter(({ providers }) =>
    (providers as readonly AiProvider[]).includes(provider)
  )
    .map(({ name }) => name)
    .join(", ");
}

/** Which features need the user's own key, given the providers the server has keys for. */
function keyRequirementText(serverKeyProviders: readonly AiProvider[]): string {
  const needKey = AI_FEATURES.filter(
    ({ providers }) => !providers.some((provider) => serverKeyProviders.includes(provider))
  ).map(({ name }) => name);
  if (needKey.length === AI_FEATURES.length) {
    return "AI features need an API key from one of these providers.";
  }
  const unlock = "to use models that aren't available by default.";
  if (needKey.length === 0) {
    return `AI features work without a key. Add your own ${unlock}`;
  }
  const list = new Intl.ListFormat("en", { type: "conjunction" }).format(needKey);
  return `You need your own key for ${list}. Add one ${unlock}`;
}

/**
 * Add/change/remove control for a single provider's API key.
 */
function ProviderKeyRow({ provider }: { provider: AiProvider }) {
  const preferencesQuery = trpc.users["me.preferences"].useQuery();
  const { update, isPending } = usePreferenceMutation();

  const { displayName: providerName, keyUrl, keyPlaceholder } = AI_PROVIDER_INFO[provider];
  const hasKey = preferencesQuery.data?.apiKeyProviders.includes(provider) ?? false;
  const isUnreadable = preferencesQuery.data?.unreadableApiKeyProviders.includes(provider) ?? false;

  return (
    <EditablePreferenceField
      id={`${provider}-api-key-input`}
      label={
        <>
          <TextLink href={keyUrl} external>
            {providerName}
          </TextLink>{" "}
          <span className="text-muted font-normal">({providerFeatures(provider)})</span>
        </>
      }
      status={
        !hasKey ? null : isUnreadable ? (
          <span className="ui-text-sm text-danger inline-flex items-center">
            <AlertIcon className="mr-1 h-4 w-4" />
            Saved key can&apos;t be read; enter it again
          </span>
        ) : (
          <span className="ui-text-sm text-success inline-flex items-center">
            <CheckIcon className="mr-1 h-4 w-4" />
            API key configured
          </span>
        )
      }
      editLabel={hasKey ? "Change" : "Add API key"}
      initialDraft=""
      onSave={(apiKey) =>
        update(
          { apiKeys: { [provider]: apiKey } },
          { success: `${providerName} API key saved`, error: "Failed to save API key" }
        )
      }
      reset={
        hasKey
          ? {
              label: "Remove",
              onReset: () =>
                void update(
                  { apiKeys: { [provider]: "" } },
                  { success: `${providerName} API key removed`, error: "Failed to remove API key" }
                ),
            }
          : undefined
      }
      isPending={isPending}
      renderInput={({ onChange, ...input }) => (
        <Input
          {...input}
          type="password"
          placeholder={keyPlaceholder}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
        />
      )}
    />
  );
}

/**
 * AI provider API keys, shared by summaries, narration and cloud voices.
 */
export function AiProviderKeySettings() {
  const serverKeyProviders = trpc.users["me.preferences"].useQuery().data?.serverKeyProviders;

  return (
    <SettingsSection
      title="AI Provider API Keys"
      description={serverKeyProviders && keyRequirementText(serverKeyProviders)}
    >
      <div className="space-y-4">
        {AI_PROVIDERS.map((provider) => (
          <ProviderKeyRow key={provider} provider={provider} />
        ))}
      </div>
    </SettingsSection>
  );
}

/**
 * The feature's model picker; a stored value missing from the list (e.g. a
 * model the provider has since retired) still shows as selected.
 */
function FeatureModelPicker({
  id,
  currentModel,
  defaultModelId,
  models,
  suggestedModelIds,
  isLoading,
  onChange,
}: {
  id: string;
  currentModel: string | null;
  defaultModelId: string;
  models: PickerModel[];
  suggestedModelIds: string[];
  isLoading: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <ModelPicker
      id={id}
      value={currentModel ? normalizeModelRef(currentModel) : null}
      defaultModelId={defaultModelId}
      models={models}
      suggestedModelIds={suggestedModelIds}
      isLoading={isLoading}
      onChange={onChange}
    />
  );
}

/**
 * Summarization model, max words, and custom prompt settings.
 */
export function SummarizationSettings() {
  const preferencesQuery = trpc.users["me.preferences"].useQuery();
  const modelsQuery = trpc.summarization.listModels.useQuery(undefined, {
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });
  const defaultPromptQuery = trpc.summarization.defaultPrompt.useQuery(undefined, {
    staleTime: 60 * 60 * 1000, // Cache for 1 hour (rarely changes)
  });
  const { update, isPending } = usePreferenceMutation();

  const currentModel = preferencesQuery.data?.summarizationModel ?? null;
  const currentMaxWords = preferencesQuery.data?.summarizationMaxWords ?? null;
  const currentPrompt = preferencesQuery.data?.summarizationPrompt ?? null;
  const models = modelsQuery.data?.models ?? [];
  const defaultModelId = modelsQuery.data?.defaultModelId ?? DEFAULT_SUMMARIZATION_MODEL;
  const defaultPrompt = defaultPromptQuery.data?.prompt ?? "";

  const handleModelChange = useCallback(
    (value: string | null) => {
      void update(
        { summarizationModel: value ?? "" },
        { success: "Model updated", error: "Failed to update model" }
      );
    },
    [update]
  );

  return (
    <SettingsSection
      title="Summaries"
      description={
        <>
          AI-powered article summaries. Requires an API key from any provider above; models from
          every configured provider are selectable.
        </>
      }
    >
      <div className="space-y-4">
        {/* Model Selection */}
        <div>
          <label
            htmlFor="summarization-model"
            className="ui-text-sm text-body mb-1.5 block font-medium"
          >
            Model
          </label>
          <FeatureModelPicker
            id="summarization-model"
            currentModel={currentModel}
            defaultModelId={defaultModelId}
            models={models}
            suggestedModelIds={SUGGESTED_SUMMARIZATION_MODELS}
            isLoading={modelsQuery.isLoading}
            onChange={handleModelChange}
          />
          <p className="ui-text-xs text-muted mt-1.5">
            Choose the model used for generating article summaries. Type to search every model from
            providers with a configured API key.
          </p>
        </div>

        <EditablePreferenceField
          id="summarization-max-words"
          label="Max words"
          hint="Maximum number of words for generated summaries."
          status={
            <span className="ui-text-sm text-muted">
              {currentMaxWords ?? `${DEFAULT_SUMMARIZATION_MAX_WORDS} (default)`}
            </span>
          }
          editLabel="Change"
          initialDraft={currentMaxWords?.toString() ?? ""}
          validate={(draft) => {
            const parsed = parseInt(draft, 10);
            return isNaN(parsed) || parsed < 1 ? "Max words must be a positive number" : null;
          }}
          onSave={(draft) =>
            update(
              { summarizationMaxWords: parseInt(draft, 10) },
              { success: "Max words updated", error: "Failed to update max words" }
            )
          }
          reset={
            currentMaxWords !== null
              ? {
                  label: "Reset",
                  onReset: () =>
                    void update(
                      { summarizationMaxWords: null },
                      { success: "Max words reset to default", error: "Failed to reset max words" }
                    ),
                }
              : undefined
          }
          isPending={isPending}
          renderInput={({ onChange, ...input }) => (
            <Input
              {...input}
              type="number"
              min={1}
              max={10000}
              placeholder={String(DEFAULT_SUMMARIZATION_MAX_WORDS)}
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        />

        <EditablePreferenceField
          id="summarization-prompt"
          label="Custom prompt"
          hint="Override the default prompt sent to the AI model when generating summaries."
          status={
            <span className="ui-text-sm text-muted">
              {currentPrompt ? "Custom prompt configured" : "Using default prompt"}
            </span>
          }
          editLabel={currentPrompt ? "Edit" : "Customize"}
          initialDraft={currentPrompt ?? ""}
          onSave={(draft) =>
            update(
              { summarizationPrompt: draft },
              { success: "Custom prompt saved", error: "Failed to save prompt" }
            )
          }
          reset={
            currentPrompt
              ? {
                  label: "Reset",
                  onReset: () =>
                    void update(
                      { summarizationPrompt: null },
                      { success: "Prompt reset to default", error: "Failed to reset prompt" }
                    ),
                }
              : undefined
          }
          isPending={isPending}
          renderInput={({ id, value, onChange, disabled }) => (
            <>
              <textarea
                id={id}
                rows={10}
                placeholder={defaultPrompt}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                className="ui-text-sm bg-surface text-body border-edge-input block w-full rounded-md border px-3 py-2 font-mono disabled:cursor-not-allowed disabled:opacity-50"
              />
              <p className="ui-text-xs text-muted">
                Available template variables: <InlineCode>{"{{content}}"}</InlineCode>,{" "}
                <InlineCode>{"{{title}}"}</InlineCode>, <InlineCode>{"{{maxWords}}"}</InlineCode>.
                The response should be wrapped in <InlineCode>{"<summary>"}</InlineCode> tags.
              </p>
            </>
          )}
        />
      </div>
    </SettingsSection>
  );
}

/**
 * Narration text processing model settings.
 */
export function NarrationAiSettings() {
  const preferencesQuery = trpc.users["me.preferences"].useQuery();
  const modelsQuery = trpc.narration.listModels.useQuery(undefined, {
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });
  const { update } = usePreferenceMutation();

  const currentModel = preferencesQuery.data?.narrationModel ?? null;
  const models = modelsQuery.data?.models ?? [];
  const defaultModelId = modelsQuery.data?.defaultModelId ?? DEFAULT_NARRATION_MODEL;

  const handleModelChange = useCallback(
    (value: string | null) => {
      void update(
        { narrationModel: value ?? "" },
        { success: "Model updated", error: "Failed to update model" }
      );
    },
    [update]
  );

  return (
    <SettingsSection
      title="AI Text Processing"
      description={
        <>
          AI-powered text processing for narration. This improves narration quality by expanding
          abbreviations and formatting content for text-to-speech. Requires an API key from{" "}
          {aiProviderNames(NARRATION_PROVIDERS)} (configured above).
        </>
      }
    >
      <div>
        <label htmlFor="narration-model" className="ui-text-sm text-body mb-1.5 block font-medium">
          Model
        </label>
        <FeatureModelPicker
          id="narration-model"
          currentModel={currentModel}
          defaultModelId={defaultModelId}
          models={models}
          suggestedModelIds={SUGGESTED_NARRATION_MODELS}
          isLoading={modelsQuery.isLoading}
          onChange={handleModelChange}
        />
        <p className="ui-text-xs text-muted mt-1.5">
          Choose the model used to prepare article text for narration. Only models that support JSON
          output are listed.
        </p>
      </div>
    </SettingsSection>
  );
}

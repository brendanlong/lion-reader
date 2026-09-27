/**
 * API Key Settings Components
 *
 * Settings sections for user-configured AI provider API keys (Anthropic,
 * Groq, Cerebras, OpenRouter) and the model settings that build on them. User keys
 * override the server's global API keys when set.
 */

"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { CheckIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TextLink } from "@/components/ui/text-link";
import { InlineCode } from "@/components/ui/inline-code";
import { AI_PROVIDER_DISPLAY_NAMES, normalizeModelRef, type AiProvider } from "@/lib/ai/model-ref";
import {
  DEFAULT_SUMMARIZATION_MODEL,
  DEFAULT_SUMMARIZATION_MAX_WORDS,
  SUGGESTED_SUMMARIZATION_MODELS,
} from "@/lib/summarization/constants";
import { DEFAULT_NARRATION_MODEL, SUGGESTED_NARRATION_MODELS } from "@/lib/narration/constants";
import type { PickerModel } from "@/lib/ai/model-picker";
import { ModelPicker } from "./ModelPicker";
import { SettingsSection } from "./SettingsSection";

interface ProviderKeyConfig {
  field: "anthropicApiKey" | "groqApiKey" | "cerebrasApiKey" | "openrouterApiKey";
  hasKeyField: "hasAnthropicApiKey" | "hasGroqApiKey" | "hasCerebrasApiKey" | "hasOpenrouterApiKey";
  provider: AiProvider;
  placeholder: string;
  keyUrl: string;
}

const PROVIDER_KEY_CONFIGS: ProviderKeyConfig[] = [
  {
    field: "anthropicApiKey",
    hasKeyField: "hasAnthropicApiKey",
    provider: "anthropic",
    placeholder: "sk-ant-...",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    field: "groqApiKey",
    hasKeyField: "hasGroqApiKey",
    provider: "groq",
    placeholder: "gsk_...",
    keyUrl: "https://console.groq.com/keys",
  },
  {
    field: "cerebrasApiKey",
    hasKeyField: "hasCerebrasApiKey",
    provider: "cerebras",
    placeholder: "csk-...",
    keyUrl: "https://cloud.cerebras.ai/",
  },
  {
    field: "openrouterApiKey",
    hasKeyField: "hasOpenrouterApiKey",
    provider: "openrouter",
    placeholder: "sk-or-...",
    keyUrl: "https://openrouter.ai/settings/keys",
  },
];

type UpdatePreferencesMutation = ReturnType<
  (typeof trpc.users)["me.updatePreferences"]["useMutation"]
>;

function updateWithToast(
  mutation: UpdatePreferencesMutation,
  input: Parameters<UpdatePreferencesMutation["mutate"]>[0],
  successMessage: string,
  errorMessage: string,
  onSuccess?: () => void
) {
  mutation.mutate(input, {
    onSuccess: () => {
      toast.success(successMessage);
      onSuccess?.();
    },
    onError: (error) => {
      toast.error(errorMessage, { description: error.message });
    },
  });
}

function SaveCancelButtons({
  onSave,
  onCancel,
  canSave,
  isPending,
}: {
  onSave: () => void;
  onCancel: () => void;
  canSave: boolean;
  isPending: boolean;
}) {
  return (
    <div className="flex gap-2">
      <Button onClick={onSave} loading={isPending} disabled={!canSave}>
        Save
      </Button>
      <Button variant="secondary" onClick={onCancel} disabled={isPending}>
        Cancel
      </Button>
    </div>
  );
}

/**
 * Add/change/remove control for a single provider's API key.
 */
function ProviderKeyRow({ config }: { config: ProviderKeyConfig }) {
  const utils = trpc.useUtils();
  const preferencesQuery = trpc.users["me.preferences"].useQuery();
  const updatePreferences = trpc.users["me.updatePreferences"].useMutation({
    onSuccess: () => {
      utils.users["me.preferences"].invalidate();
      // A key change affects availability and the model lists of both features
      utils.summarization.isAvailable.invalidate();
      utils.summarization.listModels.invalidate();
      utils.narration.isAiTextProcessingAvailable.invalidate();
      utils.narration.listModels.invalidate();
    },
  });

  const [apiKey, setApiKey] = useState("");
  const [isEditing, setIsEditing] = useState(false);

  const providerName = AI_PROVIDER_DISPLAY_NAMES[config.provider];
  const hasKey = preferencesQuery.data?.[config.hasKeyField] ?? false;

  const handleSave = useCallback(() => {
    updateWithToast(
      updatePreferences,
      { [config.field]: apiKey },
      `${providerName} API key saved`,
      "Failed to save API key",
      () => {
        setApiKey("");
        setIsEditing(false);
      }
    );
  }, [apiKey, config.field, providerName, updatePreferences]);

  const handleRemove = useCallback(() => {
    updateWithToast(
      updatePreferences,
      { [config.field]: "" },
      `${providerName} API key removed`,
      "Failed to remove API key",
      () => setIsEditing(false)
    );
  }, [config.field, providerName, updatePreferences]);

  return (
    <div>
      <label
        htmlFor={`${config.field}-input`}
        className="ui-text-sm text-body mb-1.5 block font-medium"
      >
        <TextLink href={config.keyUrl} external>
          {providerName}
        </TextLink>
      </label>
      {isEditing ? (
        <div className="space-y-3">
          <Input
            id={`${config.field}-input`}
            type="password"
            placeholder={config.placeholder}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={updatePreferences.isPending}
            autoComplete="off"
          />
          <SaveCancelButtons
            onSave={handleSave}
            onCancel={() => {
              setIsEditing(false);
              setApiKey("");
            }}
            canSave={!!apiKey.trim()}
            isPending={updatePreferences.isPending}
          />
        </div>
      ) : (
        <div className="flex items-center gap-3">
          {hasKey ? (
            <>
              <span className="ui-text-sm text-success inline-flex items-center">
                <CheckIcon className="mr-1 h-4 w-4" />
                API key configured
              </span>
              <Button variant="secondary" size="sm" onClick={() => setIsEditing(true)}>
                Change
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleRemove}
                loading={updatePreferences.isPending}
              >
                Remove
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={() => setIsEditing(true)}>
              Add API key
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * AI provider API keys, shared by summaries and narration text processing.
 */
export function AiProviderKeySettings() {
  return (
    <SettingsSection
      title="AI Provider API Keys"
      description={
        <>
          Add an API key for one or more AI providers to enable AI features: article summaries (any
          provider) and narration text processing (Groq, Cerebras, or OpenRouter). OpenRouter gives
          access to hundreds of models from many labs with one key. Keys are stored encrypted and
          override the server&apos;s keys when set.
        </>
      }
    >
      <div className="space-y-4">
        {PROVIDER_KEY_CONFIGS.map((config) => (
          <ProviderKeyRow key={config.field} config={config} />
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
  disabled,
  onChange,
}: {
  id: string;
  currentModel: string | null;
  defaultModelId: string;
  models: PickerModel[];
  suggestedModelIds: string[];
  isLoading: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <ModelPicker
      id={id}
      value={currentModel ? normalizeModelRef(currentModel) : defaultModelId}
      defaultModelId={defaultModelId}
      models={models}
      suggestedModelIds={suggestedModelIds}
      isLoading={isLoading}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

/**
 * Summarization model, max words, and custom prompt settings.
 */
export function SummarizationSettings() {
  const utils = trpc.useUtils();
  const preferencesQuery = trpc.users["me.preferences"].useQuery();
  const modelsQuery = trpc.summarization.listModels.useQuery(undefined, {
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });
  const defaultPromptQuery = trpc.summarization.defaultPrompt.useQuery(undefined, {
    staleTime: 60 * 60 * 1000, // Cache for 1 hour (rarely changes)
  });
  const updatePreferences = trpc.users["me.updatePreferences"].useMutation({
    onSuccess: () => {
      utils.users["me.preferences"].invalidate();
      utils.summarization.isAvailable.invalidate();
    },
  });

  const [maxWordsInput, setMaxWordsInput] = useState("");
  const [isEditingMaxWords, setIsEditingMaxWords] = useState(false);
  const [promptInput, setPromptInput] = useState("");
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);

  const currentModel = preferencesQuery.data?.summarizationModel ?? null;
  const currentMaxWords = preferencesQuery.data?.summarizationMaxWords ?? null;
  const currentPrompt = preferencesQuery.data?.summarizationPrompt ?? null;
  const models = modelsQuery.data?.models ?? [];
  const defaultModelId = modelsQuery.data?.defaultModelId ?? DEFAULT_SUMMARIZATION_MODEL;
  const defaultPrompt = defaultPromptQuery.data?.prompt ?? "";

  const handleModelChange = useCallback(
    (value: string) => {
      updateWithToast(
        updatePreferences,
        { summarizationModel: value || "" },
        "Model updated",
        "Failed to update model"
      );
    },
    [updatePreferences]
  );

  const handleMaxWordsSave = useCallback(() => {
    const parsed = parseInt(maxWordsInput, 10);
    if (isNaN(parsed) || parsed < 1) {
      toast.error("Max words must be a positive number");
      return;
    }
    updateWithToast(
      updatePreferences,
      { summarizationMaxWords: parsed },
      "Max words updated",
      "Failed to update max words",
      () => setIsEditingMaxWords(false)
    );
  }, [maxWordsInput, updatePreferences]);

  const handleMaxWordsReset = useCallback(() => {
    updateWithToast(
      updatePreferences,
      { summarizationMaxWords: null },
      "Max words reset to default",
      "Failed to reset max words",
      () => {
        setMaxWordsInput("");
        setIsEditingMaxWords(false);
      }
    );
  }, [updatePreferences]);

  const handlePromptSave = useCallback(() => {
    updateWithToast(
      updatePreferences,
      { summarizationPrompt: promptInput || null },
      "Custom prompt saved",
      "Failed to save prompt",
      () => setIsEditingPrompt(false)
    );
  }, [promptInput, updatePreferences]);

  const handlePromptReset = useCallback(() => {
    updateWithToast(
      updatePreferences,
      { summarizationPrompt: null },
      "Prompt reset to default",
      "Failed to reset prompt",
      () => {
        setPromptInput("");
        setIsEditingPrompt(false);
      }
    );
  }, [updatePreferences]);

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
            disabled={updatePreferences.isPending}
            onChange={handleModelChange}
          />
          <p className="ui-text-xs text-muted mt-1.5">
            Choose the model used for generating article summaries. Type to search every model from
            providers with a configured API key.
          </p>
        </div>

        {/* Max Words */}
        <div>
          <label
            htmlFor="summarization-max-words"
            className="ui-text-sm text-body mb-1.5 block font-medium"
          >
            Max words
          </label>
          {isEditingMaxWords ? (
            <div className="space-y-3">
              <Input
                id="summarization-max-words"
                type="number"
                min={1}
                max={10000}
                placeholder={String(DEFAULT_SUMMARIZATION_MAX_WORDS)}
                value={maxWordsInput}
                onChange={(e) => setMaxWordsInput(e.target.value)}
                disabled={updatePreferences.isPending}
              />
              <SaveCancelButtons
                onSave={handleMaxWordsSave}
                onCancel={() => {
                  setIsEditingMaxWords(false);
                  setMaxWordsInput(currentMaxWords?.toString() ?? "");
                }}
                canSave={!!maxWordsInput.trim()}
                isPending={updatePreferences.isPending}
              />
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className="ui-text-sm text-muted">
                {currentMaxWords ?? `${DEFAULT_SUMMARIZATION_MAX_WORDS} (default)`}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setMaxWordsInput(currentMaxWords?.toString() ?? "");
                  setIsEditingMaxWords(true);
                }}
              >
                Change
              </Button>
              {currentMaxWords !== null && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleMaxWordsReset}
                  loading={updatePreferences.isPending}
                >
                  Reset
                </Button>
              )}
            </div>
          )}
          <p className="ui-text-xs text-muted mt-1.5">
            Maximum number of words for generated summaries.
          </p>
        </div>

        {/* Custom Prompt */}
        <div>
          <label
            htmlFor="summarization-prompt"
            className="ui-text-sm text-body mb-1.5 block font-medium"
          >
            Custom prompt
          </label>
          {isEditingPrompt ? (
            <div className="space-y-3">
              <textarea
                id="summarization-prompt"
                rows={10}
                placeholder={defaultPrompt}
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                disabled={updatePreferences.isPending}
                className="ui-text-sm bg-surface text-body border-edge-input block w-full rounded-md border px-3 py-2 font-mono disabled:cursor-not-allowed disabled:opacity-50"
              />
              <p className="ui-text-xs text-muted">
                Available template variables: <InlineCode>{"{{content}}"}</InlineCode>,{" "}
                <InlineCode>{"{{title}}"}</InlineCode>, <InlineCode>{"{{maxWords}}"}</InlineCode>.
                The response should be wrapped in <InlineCode>{"<summary>"}</InlineCode> tags.
              </p>
              <SaveCancelButtons
                onSave={handlePromptSave}
                onCancel={() => {
                  setIsEditingPrompt(false);
                  setPromptInput(currentPrompt ?? "");
                }}
                canSave={!!promptInput.trim()}
                isPending={updatePreferences.isPending}
              />
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <span className="ui-text-sm text-muted">
                {currentPrompt ? "Custom prompt configured" : "Using default prompt"}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setPromptInput(currentPrompt ?? "");
                  setIsEditingPrompt(true);
                }}
              >
                {currentPrompt ? "Edit" : "Customize"}
              </Button>
              {currentPrompt && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handlePromptReset}
                  loading={updatePreferences.isPending}
                >
                  Reset
                </Button>
              )}
            </div>
          )}
          <p className="ui-text-xs text-muted mt-1.5">
            Override the default prompt sent to the AI model when generating summaries.
          </p>
        </div>
      </div>
    </SettingsSection>
  );
}

/**
 * Narration text processing model settings.
 */
export function NarrationAiSettings() {
  const utils = trpc.useUtils();
  const preferencesQuery = trpc.users["me.preferences"].useQuery();
  const modelsQuery = trpc.narration.listModels.useQuery(undefined, {
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });
  const updatePreferences = trpc.users["me.updatePreferences"].useMutation({
    onSuccess: () => {
      utils.users["me.preferences"].invalidate();
      utils.narration.isAiTextProcessingAvailable.invalidate();
    },
  });

  const currentModel = preferencesQuery.data?.narrationModel ?? null;
  const models = modelsQuery.data?.models ?? [];
  const defaultModelId = modelsQuery.data?.defaultModelId ?? DEFAULT_NARRATION_MODEL;

  const handleModelChange = useCallback(
    (value: string) => {
      updateWithToast(
        updatePreferences,
        { narrationModel: value || "" },
        "Model updated",
        "Failed to update model"
      );
    },
    [updatePreferences]
  );

  return (
    <SettingsSection
      title="AI Text Processing"
      description={
        <>
          AI-powered text processing for narration. This improves narration quality by expanding
          abbreviations and formatting content for text-to-speech. Requires a Groq, Cerebras, or
          OpenRouter API key (configured above).
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
          disabled={updatePreferences.isPending}
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

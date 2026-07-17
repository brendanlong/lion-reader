/**
 * API Key Settings Components
 *
 * Settings sections for user-configured AI provider API keys (Anthropic,
 * Groq, Cerebras) and the model settings that build on them. User keys
 * override the server's global API keys when set.
 */

"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { CheckIcon } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TextLink } from "@/components/ui/text-link";
import { InlineCode } from "@/components/ui/inline-code";
import {
  AI_PROVIDER_DISPLAY_NAMES,
  AI_PROVIDERS,
  normalizeModelRef,
  type AiProvider,
} from "@/lib/ai/model-ref";
import {
  DEFAULT_SUMMARIZATION_MODEL,
  DEFAULT_SUMMARIZATION_MAX_WORDS,
} from "@/lib/summarization/constants";
import { DEFAULT_NARRATION_MODEL } from "@/lib/narration/constants";
import { SettingsSection } from "./SettingsSection";

interface ProviderKeyConfig {
  field: "anthropicApiKey" | "groqApiKey" | "cerebrasApiKey";
  hasKeyField: "hasAnthropicApiKey" | "hasGroqApiKey" | "hasCerebrasApiKey";
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
];

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
    updatePreferences.mutate(
      { [config.field]: apiKey },
      {
        onSuccess: () => {
          toast.success(`${providerName} API key saved`);
          setApiKey("");
          setIsEditing(false);
        },
        onError: (error) => {
          toast.error("Failed to save API key", { description: error.message });
        },
      }
    );
  }, [apiKey, config.field, providerName, updatePreferences]);

  const handleRemove = useCallback(() => {
    updatePreferences.mutate(
      { [config.field]: "" },
      {
        onSuccess: () => {
          toast.success(`${providerName} API key removed`);
          setIsEditing(false);
        },
        onError: (error) => {
          toast.error("Failed to remove API key", { description: error.message });
        },
      }
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
          <div className="flex gap-2">
            <Button
              onClick={handleSave}
              loading={updatePreferences.isPending}
              disabled={!apiKey.trim()}
            >
              Save
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setIsEditing(false);
                setApiKey("");
              }}
              disabled={updatePreferences.isPending}
            >
              Cancel
            </Button>
          </div>
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
  const preferencesQuery = trpc.users["me.preferences"].useQuery();

  return (
    <SettingsSection
      title="AI Provider API Keys"
      description={
        <>
          Add an API key for one or more AI providers to enable AI features: article summaries (any
          provider) and narration text processing (Groq or Cerebras). Keys are stored encrypted and
          override the server&apos;s keys when set.
        </>
      }
    >
      {preferencesQuery.isLoading ? (
        <div className="bg-surface-muted h-10 w-full animate-pulse rounded" />
      ) : (
        <div className="space-y-4">
          {PROVIDER_KEY_CONFIGS.map((config) => (
            <ProviderKeyRow key={config.field} config={config} />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

interface ModelOption {
  id: string;
  displayName: string;
  provider: AiProvider;
}

/**
 * A model select grouped by provider, with a "(default)" marker and support
 * for a stored value that's missing from the list.
 */
function ModelSelect({
  id,
  currentModel,
  defaultModelId,
  models,
  isLoading,
  disabled,
  onChange,
}: {
  id: string;
  currentModel: string | null;
  defaultModelId: string;
  models: ModelOption[];
  isLoading: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const normalizedCurrent = currentModel ? normalizeModelRef(currentModel) : null;
  const value = normalizedCurrent ?? defaultModelId;
  const providers = AI_PROVIDERS.filter((provider) =>
    models.some((model) => model.provider === provider)
  );

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || isLoading}
      className="ui-text-sm bg-surface text-body border-edge-input block w-full rounded-md border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {isLoading ? (
        <option value={value}>Loading models...</option>
      ) : models.length > 0 ? (
        providers.map((provider) => (
          <optgroup key={provider} label={AI_PROVIDER_DISPLAY_NAMES[provider]}>
            {models
              .filter((model) => model.provider === provider)
              .map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                  {model.id === defaultModelId ? " (default)" : ""}
                </option>
              ))}
          </optgroup>
        ))
      ) : (
        <option value={defaultModelId}>{defaultModelId}</option>
      )}
      {/* Show custom value if it's not in the models list */}
      {normalizedCurrent &&
        !isLoading &&
        models.length > 0 &&
        !models.some((m) => m.id === normalizedCurrent) && (
          <option value={normalizedCurrent}>{normalizedCurrent}</option>
        )}
    </select>
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
      updatePreferences.mutate(
        { summarizationModel: value || "" },
        {
          onSuccess: () => {
            toast.success("Model updated");
          },
          onError: (error) => {
            toast.error("Failed to update model", { description: error.message });
          },
        }
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
    updatePreferences.mutate(
      { summarizationMaxWords: parsed },
      {
        onSuccess: () => {
          toast.success("Max words updated");
          setIsEditingMaxWords(false);
        },
        onError: (error) => {
          toast.error("Failed to update max words", { description: error.message });
        },
      }
    );
  }, [maxWordsInput, updatePreferences]);

  const handleMaxWordsReset = useCallback(() => {
    updatePreferences.mutate(
      { summarizationMaxWords: null },
      {
        onSuccess: () => {
          toast.success("Max words reset to default");
          setMaxWordsInput("");
          setIsEditingMaxWords(false);
        },
        onError: (error) => {
          toast.error("Failed to reset max words", { description: error.message });
        },
      }
    );
  }, [updatePreferences]);

  const handlePromptSave = useCallback(() => {
    updatePreferences.mutate(
      { summarizationPrompt: promptInput || null },
      {
        onSuccess: () => {
          toast.success("Custom prompt saved");
          setIsEditingPrompt(false);
        },
        onError: (error) => {
          toast.error("Failed to save prompt", { description: error.message });
        },
      }
    );
  }, [promptInput, updatePreferences]);

  const handlePromptReset = useCallback(() => {
    updatePreferences.mutate(
      { summarizationPrompt: null },
      {
        onSuccess: () => {
          toast.success("Prompt reset to default");
          setPromptInput("");
          setIsEditingPrompt(false);
        },
        onError: (error) => {
          toast.error("Failed to reset prompt", { description: error.message });
        },
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
      {preferencesQuery.isLoading ? (
        <div className="bg-surface-muted h-10 w-full animate-pulse rounded" />
      ) : (
        <div className="space-y-4">
          {/* Model Selection */}
          <div>
            <label
              htmlFor="summarization-model"
              className="ui-text-sm text-body mb-1.5 block font-medium"
            >
              Model
            </label>
            <ModelSelect
              id="summarization-model"
              currentModel={currentModel}
              defaultModelId={defaultModelId}
              models={models}
              isLoading={modelsQuery.isLoading}
              disabled={updatePreferences.isPending}
              onChange={handleModelChange}
            />
            <p className="ui-text-xs text-muted mt-1.5">
              Choose the model used for generating article summaries. Only providers with a
              configured API key are listed.
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
                <div className="flex gap-2">
                  <Button
                    onClick={handleMaxWordsSave}
                    loading={updatePreferences.isPending}
                    disabled={!maxWordsInput.trim()}
                  >
                    Save
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setIsEditingMaxWords(false);
                      setMaxWordsInput(currentMaxWords?.toString() ?? "");
                    }}
                    disabled={updatePreferences.isPending}
                  >
                    Cancel
                  </Button>
                </div>
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
                <div className="flex gap-2">
                  <Button
                    onClick={handlePromptSave}
                    loading={updatePreferences.isPending}
                    disabled={!promptInput.trim()}
                  >
                    Save
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setIsEditingPrompt(false);
                      setPromptInput(currentPrompt ?? "");
                    }}
                    disabled={updatePreferences.isPending}
                  >
                    Cancel
                  </Button>
                </div>
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
      )}
    </SettingsSection>
  );
}

/**
 * Narration text-processing model settings.
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
      updatePreferences.mutate(
        { narrationModel: value || "" },
        {
          onSuccess: () => {
            toast.success("Model updated");
          },
          onError: (error) => {
            toast.error("Failed to update model", { description: error.message });
          },
        }
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
          abbreviations and formatting content for text-to-speech. Requires a Groq or Cerebras API
          key (configured above).
        </>
      }
    >
      {preferencesQuery.isLoading ? (
        <div className="bg-surface-muted h-10 w-full animate-pulse rounded" />
      ) : (
        <div>
          <label
            htmlFor="narration-model"
            className="ui-text-sm text-body mb-1.5 block font-medium"
          >
            Model
          </label>
          <ModelSelect
            id="narration-model"
            currentModel={currentModel}
            defaultModelId={defaultModelId}
            models={models}
            isLoading={modelsQuery.isLoading}
            disabled={updatePreferences.isPending}
            onChange={handleModelChange}
          />
          <p className="ui-text-xs text-muted mt-1.5">
            Choose the model used to prepare article text for narration. Only Groq and Cerebras
            models are supported.
          </p>
        </div>
      )}
    </SettingsSection>
  );
}

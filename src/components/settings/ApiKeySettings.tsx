/**
 * API Key Settings Components
 *
 * Settings sections for user-configured Groq and Anthropic API keys.
 * These override the server's global API keys when set.
 */

"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { CheckIcon } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_SUMMARIZATION_MODEL,
  DEFAULT_SUMMARIZATION_MAX_WORDS,
} from "@/lib/summarization/constants";

/**
 * Groq API key settings, displayed near the narration settings.
 */
export function GroqApiKeySettings() {
  const utils = trpc.useUtils();
  const preferencesQuery = trpc.users["me.preferences"].useQuery();
  const updatePreferences = trpc.users["me.updatePreferences"].useMutation({
    onSuccess: () => {
      utils.users["me.preferences"].invalidate();
      utils.narration.isAiTextProcessingAvailable.invalidate();
    },
  });

  const [apiKey, setApiKey] = useState("");
  const [isEditing, setIsEditing] = useState(false);

  const hasKey = preferencesQuery.data?.hasGroqApiKey ?? false;

  const handleSave = useCallback(() => {
    updatePreferences.mutate(
      { groqApiKey: apiKey },
      {
        onSuccess: () => {
          toast.success("Groq API key saved");
          setApiKey("");
          setIsEditing(false);
        },
        onError: (error) => {
          toast.error("Failed to save API key", { description: error.message });
        },
      }
    );
  }, [apiKey, updatePreferences]);

  const handleRemove = useCallback(() => {
    updatePreferences.mutate(
      { groqApiKey: "" },
      {
        onSuccess: () => {
          toast.success("Groq API key removed");
          setIsEditing(false);
        },
        onError: (error) => {
          toast.error("Failed to remove API key", { description: error.message });
        },
      }
    );
  }, [updatePreferences]);

  return (
    <section>
      <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">
        AI Text Processing
      </h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="ui-text-sm mb-4 text-zinc-600 dark:text-zinc-400">
          Add a{" "}
          <a
            href="https://console.groq.com/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:text-accent-hover font-medium"
          >
            Groq API key
          </a>{" "}
          to enable AI-powered text processing for narration. This improves narration quality by
          expanding abbreviations and formatting content for text-to-speech.
        </p>

        {preferencesQuery.isLoading ? (
          <div className="h-10 w-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
        ) : isEditing ? (
          <div className="space-y-3">
            <Input
              id="groq-api-key"
              type="password"
              placeholder="gsk_..."
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
                <span className="ui-text-sm inline-flex items-center text-green-600 dark:text-green-400">
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
    </section>
  );
}

/**
 * Anthropic API key, model, and summarization settings.
 */
export function SummarizationApiKeySettings() {
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
      // Refetch models list since the API key may have changed
      utils.summarization.listModels.invalidate();
    },
  });

  const [apiKey, setApiKey] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [maxWordsInput, setMaxWordsInput] = useState("");
  const [isEditingMaxWords, setIsEditingMaxWords] = useState(false);
  const [promptInput, setPromptInput] = useState("");
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);

  const hasKey = preferencesQuery.data?.hasAnthropicApiKey ?? false;
  const currentModel = preferencesQuery.data?.summarizationModel ?? null;
  const currentMaxWords = preferencesQuery.data?.summarizationMaxWords ?? null;
  const currentPrompt = preferencesQuery.data?.summarizationPrompt ?? null;
  const models = modelsQuery.data?.models ?? [];
  const defaultModelId = modelsQuery.data?.defaultModelId ?? DEFAULT_SUMMARIZATION_MODEL;
  const defaultPrompt = defaultPromptQuery.data?.prompt ?? "";

  const handleSave = useCallback(() => {
    updatePreferences.mutate(
      { anthropicApiKey: apiKey },
      {
        onSuccess: () => {
          toast.success("Anthropic API key saved");
          setApiKey("");
          setIsEditing(false);
        },
        onError: (error) => {
          toast.error("Failed to save API key", { description: error.message });
        },
      }
    );
  }, [apiKey, updatePreferences]);

  const handleRemove = useCallback(() => {
    updatePreferences.mutate(
      { anthropicApiKey: "" },
      {
        onSuccess: () => {
          toast.success("Anthropic API key removed");
          setIsEditing(false);
        },
        onError: (error) => {
          toast.error("Failed to remove API key", { description: error.message });
        },
      }
    );
  }, [updatePreferences]);

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
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
    <section>
      <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">Summaries</h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="ui-text-sm mb-4 text-zinc-600 dark:text-zinc-400">
          Add an{" "}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:text-accent-hover font-medium"
          >
            Anthropic API key
          </a>{" "}
          to enable AI-powered article summaries.
        </p>

        {preferencesQuery.isLoading ? (
          <div className="h-10 w-full animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
        ) : (
          <div className="space-y-4">
            {/* API Key */}
            {isEditing ? (
              <div className="space-y-3">
                <Input
                  id="anthropic-api-key"
                  type="password"
                  placeholder="sk-ant-..."
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
                    <span className="ui-text-sm inline-flex items-center text-green-600 dark:text-green-400">
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

            {/* Model Selection */}
            <div>
              <label
                htmlFor="summarization-model"
                className="ui-text-sm mb-1.5 block font-medium text-zinc-700 dark:text-zinc-300"
              >
                Model
              </label>
              <select
                id="summarization-model"
                value={currentModel ?? defaultModelId}
                onChange={handleModelChange}
                disabled={updatePreferences.isPending || modelsQuery.isLoading}
                className="ui-text-sm block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400 dark:focus:ring-zinc-400"
              >
                {modelsQuery.isLoading ? (
                  <option value={currentModel ?? defaultModelId}>Loading models...</option>
                ) : models.length > 0 ? (
                  models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName}
                      {model.id === defaultModelId ? " (default)" : ""}
                    </option>
                  ))
                ) : (
                  <option value={defaultModelId}>{defaultModelId}</option>
                )}
                {/* Show custom value if it's not in the models list */}
                {currentModel &&
                  !modelsQuery.isLoading &&
                  models.length > 0 &&
                  !models.some((m) => m.id === currentModel) && (
                    <option value={currentModel}>{currentModel}</option>
                  )}
              </select>
              <p className="ui-text-xs mt-1.5 text-zinc-500 dark:text-zinc-400">
                Choose the Anthropic model used for generating article summaries. Sonnet models
                offer the best balance of quality and cost.
              </p>
            </div>

            {/* Max Words */}
            <div>
              <label
                htmlFor="summarization-max-words"
                className="ui-text-sm mb-1.5 block font-medium text-zinc-700 dark:text-zinc-300"
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
                  <span className="ui-text-sm text-zinc-600 dark:text-zinc-400">
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
              <p className="ui-text-xs mt-1.5 text-zinc-500 dark:text-zinc-400">
                Maximum number of words for generated summaries.
              </p>
            </div>

            {/* Custom Prompt */}
            <div>
              <label
                htmlFor="summarization-prompt"
                className="ui-text-sm mb-1.5 block font-medium text-zinc-700 dark:text-zinc-300"
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
                    className="ui-text-sm block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-zinc-900 focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400 dark:focus:ring-zinc-400"
                  />
                  <p className="ui-text-xs text-zinc-500 dark:text-zinc-400">
                    Available template variables:{" "}
                    <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
                      {"{{content}}"}
                    </code>
                    ,{" "}
                    <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{"{{title}}"}</code>
                    ,{" "}
                    <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
                      {"{{maxWords}}"}
                    </code>
                    . The response should be wrapped in{" "}
                    <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{"<summary>"}</code>{" "}
                    tags.
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
                  <span className="ui-text-sm text-zinc-600 dark:text-zinc-400">
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
              <p className="ui-text-xs mt-1.5 text-zinc-500 dark:text-zinc-400">
                Override the default prompt sent to the AI model when generating summaries.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

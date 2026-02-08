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
import { Button, Input } from "@/components/ui";

const DEFAULT_MODEL = "claude-sonnet-4-5";

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
            className="font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
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
                  <svg
                    className="mr-1 h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
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
 * Anthropic API key and model settings for summarization.
 */
export function SummarizationApiKeySettings() {
  const utils = trpc.useUtils();
  const preferencesQuery = trpc.users["me.preferences"].useQuery();
  const modelsQuery = trpc.summarization.listModels.useQuery(undefined, {
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
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

  const hasKey = preferencesQuery.data?.hasAnthropicApiKey ?? false;
  const currentModel = preferencesQuery.data?.summarizationModel ?? null;
  const models = modelsQuery.data?.models ?? [];

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
            className="font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
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
                      <svg
                        className="mr-1 h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
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
                value={currentModel ?? DEFAULT_MODEL}
                onChange={handleModelChange}
                disabled={updatePreferences.isPending || modelsQuery.isLoading}
                className="ui-text-sm block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400 dark:focus:ring-zinc-400"
              >
                {modelsQuery.isLoading ? (
                  <option value={currentModel ?? DEFAULT_MODEL}>Loading models...</option>
                ) : models.length > 0 ? (
                  models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName}
                    </option>
                  ))
                ) : (
                  <option value={DEFAULT_MODEL}>Claude Sonnet 4.5</option>
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
          </div>
        )}
      </div>
    </section>
  );
}

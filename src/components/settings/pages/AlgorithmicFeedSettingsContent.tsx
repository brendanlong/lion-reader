/**
 * Algorithmic Feed Settings Content
 *
 * Settings page for enabling/disabling the algorithmic feed feature
 * and configuring Best feed sorting weights.
 * When disabled, score models are not trained, the "Best" feed is hidden,
 * and voting controls are not shown.
 */

"use client";

import { useState, useCallback } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/trpc/root";

type Preferences = inferRouterOutputs<AppRouter>["users"]["me.preferences"];

export default function AlgorithmicFeedSettingsContent() {
  const preferencesQuery = trpc.users["me.preferences"].useQuery();
  const preferences = preferencesQuery.data;
  const enabled = preferences?.algorithmicFeedEnabled ?? true;

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h2 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Algorithmic Feed
        </h2>
        <p className="ui-text-sm mt-1 text-zinc-500 dark:text-zinc-400">
          Configure the algorithmic feed that learns your preferences and ranks entries by predicted
          interest.
        </p>
      </div>

      <AlgorithmicFeedToggle enabled={enabled} isLoading={preferencesQuery.isLoading} />
      {enabled && (
        <BestFeedWeights preferences={preferences} isLoading={preferencesQuery.isLoading} />
      )}
    </div>
  );
}

function AlgorithmicFeedToggle({ enabled, isLoading }: { enabled: boolean; isLoading: boolean }) {
  const utils = trpc.useUtils();

  const updateMutation = trpc.users["me.updatePreferences"].useMutation({
    onMutate: async (newPrefs) => {
      await utils.users["me.preferences"].cancel();

      const previousPrefs = utils.users["me.preferences"].getData();

      utils.users["me.preferences"].setData(undefined, (old) =>
        old
          ? {
              ...old,
              algorithmicFeedEnabled: newPrefs.algorithmicFeedEnabled ?? old.algorithmicFeedEnabled,
            }
          : undefined
      );

      return { previousPrefs };
    },
    onError: (_error, _newPrefs, context) => {
      if (context?.previousPrefs) {
        utils.users["me.preferences"].setData(undefined, context.previousPrefs);
      }
      toast.error("Failed to update preference");
    },
    onSuccess: () => {
      toast.success("Preference updated");
      // Invalidate sidebar queries that depend on this setting
      utils.entries.hasScoredEntries.invalidate();
    },
    onSettled: (_data, error) => {
      if (error) {
        utils.users["me.preferences"].invalidate();
      }
    },
  });

  const handleToggle = () => {
    updateMutation.mutate({ algorithmicFeedEnabled: !enabled });
  };

  return (
    <section>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-50">
              Enable algorithmic feed
            </h4>
            <p className="ui-text-sm mt-1 text-zinc-500 dark:text-zinc-400">
              Train a personalized model based on your reading habits and votes. When enabled, a
              &quot;Best&quot; feed sorts entries by predicted interest and voting controls appear
              on entries.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={handleToggle}
            disabled={isLoading || updateMutation.isPending}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:focus:ring-offset-zinc-900 ${
              enabled ? "bg-zinc-900 dark:bg-zinc-50" : "bg-zinc-200 dark:bg-zinc-700"
            }`}
          >
            <span
              aria-hidden="true"
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out dark:bg-zinc-900 ${
                enabled ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>
    </section>
  );
}

function BestFeedWeights({
  preferences,
  isLoading,
}: {
  preferences: Preferences | undefined;
  isLoading: boolean;
}) {
  const utils = trpc.useUtils();

  const serverScoreWeight = preferences?.bestFeedScoreWeight ?? 1;
  const serverUncertaintyWeight = preferences?.bestFeedUncertaintyWeight ?? 1;

  const [scoreWeight, setScoreWeight] = useState<number | null>(null);
  const [uncertaintyWeight, setUncertaintyWeight] = useState<number | null>(null);

  // Use local state if user is editing, otherwise use server state
  const displayScoreWeight = scoreWeight ?? serverScoreWeight;
  const displayUncertaintyWeight = uncertaintyWeight ?? serverUncertaintyWeight;

  const updateMutation = trpc.users["me.updatePreferences"].useMutation({
    onMutate: async (newPrefs) => {
      await utils.users["me.preferences"].cancel();
      const previousPrefs = utils.users["me.preferences"].getData();

      utils.users["me.preferences"].setData(undefined, (old) =>
        old
          ? {
              ...old,
              bestFeedScoreWeight: newPrefs.bestFeedScoreWeight ?? old.bestFeedScoreWeight,
              bestFeedUncertaintyWeight:
                newPrefs.bestFeedUncertaintyWeight ?? old.bestFeedUncertaintyWeight,
            }
          : undefined
      );

      return { previousPrefs };
    },
    onError: (_error, _newPrefs, context) => {
      if (context?.previousPrefs) {
        utils.users["me.preferences"].setData(undefined, context.previousPrefs);
      }
      toast.error("Failed to update weights");
    },
    onSuccess: () => {
      toast.success("Weights updated");
      // Invalidate the Best feed query since sort order changed
      utils.entries.list.invalidate();
    },
    onSettled: (_data, error) => {
      // Clear local state so we use server values
      setScoreWeight(null);
      setUncertaintyWeight(null);
      if (error) {
        utils.users["me.preferences"].invalidate();
      }
    },
  });

  const handleSave = useCallback(() => {
    updateMutation.mutate({
      bestFeedScoreWeight: displayScoreWeight,
      bestFeedUncertaintyWeight: displayUncertaintyWeight,
    });
  }, [updateMutation, displayScoreWeight, displayUncertaintyWeight]);

  const hasChanges =
    displayScoreWeight !== serverScoreWeight ||
    displayUncertaintyWeight !== serverUncertaintyWeight;

  return (
    <section>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4">
          <h4 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-50">
            Best feed sorting weights
          </h4>
          <p className="ui-text-sm mt-1 text-zinc-500 dark:text-zinc-400">
            Control how the Best feed ranks entries. The sort formula is: score weight &times;
            predicted score + uncertainty weight &times; uncertainty. Higher uncertainty weight
            surfaces entries the model is less sure about, helping you discover new content.
          </p>
        </div>

        <div className="space-y-4">
          <WeightSlider
            label="Score weight"
            value={displayScoreWeight}
            onChange={setScoreWeight}
            disabled={isLoading || updateMutation.isPending}
          />
          <WeightSlider
            label="Uncertainty weight"
            value={displayUncertaintyWeight}
            onChange={setUncertaintyWeight}
            disabled={isLoading || updateMutation.isPending}
          />
        </div>

        {hasChanges && (
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={handleSave}
              disabled={updateMutation.isPending}
              className="ui-text-sm rounded-md bg-zinc-900 px-3 py-1.5 font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              Save
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function WeightSlider({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-4">
      <label className="ui-text-sm w-40 flex-shrink-0 text-zinc-700 dark:text-zinc-300">
        {label}
      </label>
      <input
        type="range"
        min={0}
        max={5}
        step={0.1}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        disabled={disabled}
        className="h-2 flex-1 cursor-pointer appearance-none rounded-lg bg-zinc-200 accent-zinc-900 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-700 dark:accent-zinc-50"
      />
      <span className="ui-text-sm w-10 text-right text-zinc-600 tabular-nums dark:text-zinc-400">
        {value.toFixed(1)}
      </span>
    </div>
  );
}

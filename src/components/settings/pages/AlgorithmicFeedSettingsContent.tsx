/**
 * Algorithmic Feed Settings Content
 *
 * Settings page for enabling/disabling the algorithmic feed feature.
 * When disabled, score models are not trained, the "Best" feed is hidden,
 * and voting controls are not shown.
 */

"use client";

import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";

export default function AlgorithmicFeedSettingsContent() {
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

      <AlgorithmicFeedToggle />
    </div>
  );
}

function AlgorithmicFeedToggle() {
  const preferencesQuery = trpc.users["me.preferences"].useQuery();
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

  const enabled = preferencesQuery.data?.algorithmicFeedEnabled ?? true;

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
            disabled={preferencesQuery.isLoading || updateMutation.isPending}
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

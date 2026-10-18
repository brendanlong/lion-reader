/**
 * usePreferenceMutation Hook
 *
 * The one `users.me.updatePreferences` mutation every settings panel uses. It
 * owns the cache side of a preference change: the response (the full
 * preferences) replaces `me.preferences`, and the queries derived from the
 * changed preferences are invalidated, so no panel can forget one.
 */

"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { trpc, type TRPCClientUtils } from "@/lib/trpc/client";

type UpdatePreferencesMutation = ReturnType<
  (typeof trpc.users)["me.updatePreferences"]["useMutation"]
>;

export type PreferencesUpdate = Parameters<UpdatePreferencesMutation["mutate"]>[0];

export interface PreferenceUpdateMessages {
  /** Toasted when the update lands. */
  success: string;
  /** Toast title on failure; the server's message is the description. */
  error: string;
}

/** Invalidates the queries that read the preferences `update` changed. */
function invalidateDependents(utils: TRPCClientUtils, update: PreferencesUpdate): void {
  if (update.apiKeys) {
    // A key changes availability and every model and voice list.
    void utils.summarization.invalidate();
    void utils.narration.invalidate();
    return;
  }
  if (update.summarizationModel !== undefined) {
    void utils.summarization.isAvailable.invalidate();
  }
  if (update.narrationModel !== undefined) {
    void utils.narration.isAiTextProcessingAvailable.invalidate();
  }
}

export interface UsePreferenceMutationResult {
  /** Sends `update` and toasts the outcome; resolves to whether it succeeded. */
  update: (update: PreferencesUpdate, messages: PreferenceUpdateMessages) => Promise<boolean>;
  isPending: boolean;
  /**
   * The update in flight, if any. A control may render it until the response
   * lands (no cache write, so nothing to roll back if it fails).
   */
  pendingUpdate: PreferencesUpdate | undefined;
}

export function usePreferenceMutation(): UsePreferenceMutationResult {
  const utils = trpc.useUtils();
  const mutation = trpc.users["me.updatePreferences"].useMutation({
    onSuccess: (preferences, update) => {
      utils.users["me.preferences"].setData(undefined, preferences);
      invalidateDependents(utils, update);
    },
  });
  const { mutateAsync } = mutation;

  const update = useCallback(
    async (input: PreferencesUpdate, messages: PreferenceUpdateMessages): Promise<boolean> => {
      try {
        await mutateAsync(input);
        toast.success(messages.success);
        return true;
      } catch (error) {
        toast.error(messages.error, {
          description: error instanceof Error ? error.message : undefined,
        });
        return false;
      }
    },
    [mutateAsync]
  );

  return {
    update,
    isPending: mutation.isPending,
    pendingUpdate: mutation.isPending ? mutation.variables : undefined,
  };
}

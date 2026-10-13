/**
 * The open entry's full content: its subscription's setting, the toggle, and
 * fetching it (on demand, and once on open when the setting is on).
 */

"use client";

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { applySubscriptionUpdate } from "@/lib/cache/operations";
import { showsFullContent } from "@/lib/narration/select-content";

interface FullContentEntry {
  fetchFullContent: boolean;
  fullContentOriginal?: string | null;
  fullContentCleaned?: string | null;
  fullContentFetchedAt?: Date | null;
  fullContentError?: string | null;
}

interface FullContent {
  fetchFullContent: boolean;
  isShowingFullContent: boolean;
  isFetching: boolean;
  /** Undefined when the entry has no subscription with the setting. */
  toggle: (() => void) | undefined;
}

/**
 * @param subscriptionId - The subscription whose setting the toggle changes,
 *   or null when there is none (a saved article)
 */
export function useFullContent(
  entryId: string,
  entry: FullContentEntry | undefined,
  subscriptionId: string | null | undefined
): FullContent {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const fetchFullContent = entry?.fetchFullContent ?? false;

  const updateSubscriptionMutation = trpc.subscriptions.update.useMutation({
    onSuccess: (row) => applySubscriptionUpdate(utils, queryClient, row),
    onError: (error) => {
      toast.error("Failed to update subscription setting", {
        description: error.message,
      });
    },
  });

  const fetchMutation = trpc.entries.fetchFullContent.useMutation({
    onSuccess: (result) => {
      // The updated entry carries fullContentFetchedAt/fullContentError.
      if (result.entry) {
        utils.entries.get.setData({ id: entryId }, (oldData) => {
          if (!oldData) return oldData;
          return { entry: { ...oldData.entry, ...result.entry } };
        });
      } else {
        utils.entries.get.invalidate({ id: entryId });
      }

      if (!result.success && result.error) {
        toast.error("Failed to fetch full content", {
          description: result.error,
        });
      }
    },
    onError: (error) => {
      toast.error("Failed to fetch full content", {
        description: error.message,
      });
    },
  });

  // Fetched unless a fetch already succeeded; a previous error is retried.
  const needsFetch = !!entry && (!entry.fullContentFetchedAt || !!entry.fullContentError);

  const toggle = useCallback(() => {
    if (!subscriptionId) return;
    const newValue = !fetchFullContent;
    updateSubscriptionMutation.mutate({ id: subscriptionId, fetchFullContent: newValue });
    if (newValue && needsFetch) fetchMutation.mutate({ id: entryId });
  }, [
    subscriptionId,
    fetchFullContent,
    needsFetch,
    entryId,
    updateSubscriptionMutation,
    fetchMutation,
  ]);

  const hasAutoFetched = useRef(false);
  useEffect(() => {
    if (hasAutoFetched.current || !fetchFullContent || !needsFetch) return;
    if (fetchMutation.isPending) return;
    hasAutoFetched.current = true;
    fetchMutation.mutate({ id: entryId });
  }, [fetchFullContent, needsFetch, entryId, fetchMutation]);

  return {
    fetchFullContent,
    isShowingFullContent: !!entry && showsFullContent(entry),
    isFetching: fetchMutation.isPending,
    toggle: subscriptionId ? toggle : undefined,
  };
}

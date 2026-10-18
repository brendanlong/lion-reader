/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { procedureError } from "@/lib/trpc/handler-link";
import { usePreferenceMutation, type PreferencesUpdate } from "@/lib/hooks/usePreferenceMutation";
import { renderHookWithTrpc, type ProcedureHandlers } from "../../../utils/component-test-helpers";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const PREFERENCES = {
  showSpam: false,
  canConfigureApiKeys: true,
  apiKeyProviders: [],
  unreadableApiKeyProviders: [],
  summarizationModel: null,
  summarizationMaxWords: null,
  summarizationPrompt: null,
  narrationModel: null,
};

const MESSAGES = { success: "Saved", error: "Failed to save" };

function handlers(overrides: ProcedureHandlers = {}): ProcedureHandlers {
  return {
    "users.me.preferences": () => PREFERENCES,
    "users.me.updatePreferences": () => ({ ...PREFERENCES, showSpam: true }),
    "summarization.isAvailable": () => ({ available: false }),
    "summarization.listModels": () => ({ models: [], defaultModelId: "m" }),
    "narration.isAiTextProcessingAvailable": () => ({ available: false }),
    "narration.listModels": () => ({ models: [], defaultModelId: "m" }),
    ...overrides,
  };
}

/** The hook plus every query a preference change can make stale, all mounted. */
function useHookWithDependents() {
  const preferences = trpc.users["me.preferences"].useQuery();
  trpc.summarization.isAvailable.useQuery();
  trpc.summarization.listModels.useQuery();
  trpc.narration.isAiTextProcessingAvailable.useQuery();
  trpc.narration.listModels.useQuery();
  return { preferences: preferences.data, mutation: usePreferenceMutation() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("usePreferenceMutation", () => {
  it("replaces me.preferences with the response, without refetching it", async () => {
    const { result, callsFor } = renderHookWithTrpc(useHookWithDependents, {
      handlers: handlers(),
    });
    await waitFor(() => expect(result.current.preferences).toBeDefined());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.mutation.update({ showSpam: true }, MESSAGES);
    });

    expect(ok).toBe(true);
    await waitFor(() => expect(result.current.preferences?.showSpam).toBe(true));
    expect(callsFor("users.me.preferences")).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledWith("Saved");
  });

  it.each<[string, PreferencesUpdate, string[]]>([
    [
      "an API key refetches every summarization and narration query",
      { apiKeys: { anthropic: "sk-test" } },
      [
        "summarization.isAvailable",
        "summarization.listModels",
        "narration.isAiTextProcessingAvailable",
        "narration.listModels",
      ],
    ],
    [
      "the summarization model refetches summarization availability",
      { summarizationModel: "anthropic:claude" },
      ["summarization.isAvailable"],
    ],
    [
      "the narration model refetches narration availability",
      { narrationModel: "anthropic:claude" },
      ["narration.isAiTextProcessingAvailable"],
    ],
    ["the spam preference refetches nothing", { showSpam: true }, []],
  ])("%s", async (_name, update, refetched) => {
    const { result, callsFor } = renderHookWithTrpc(useHookWithDependents, {
      handlers: handlers(),
    });
    const dependents = [
      "summarization.isAvailable",
      "summarization.listModels",
      "narration.isAiTextProcessingAvailable",
      "narration.listModels",
    ];
    await waitFor(() => {
      for (const path of dependents) expect(callsFor(path)).toHaveLength(1);
    });

    await act(async () => {
      await result.current.mutation.update(update, MESSAGES);
    });

    await waitFor(() => {
      for (const path of dependents) {
        expect(callsFor(path)).toHaveLength(refetched.includes(path) ? 2 : 1);
      }
    });
  });

  it("toasts the server's message on failure and leaves the preferences alone", async () => {
    const { result } = renderHookWithTrpc(useHookWithDependents, {
      handlers: handlers({
        "users.me.updatePreferences": () => {
          throw procedureError("BAD_REQUEST", "Encryption is not configured");
        },
      }),
    });
    await waitFor(() => expect(result.current.preferences).toBeDefined());

    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.mutation.update({ showSpam: true }, MESSAGES);
    });

    expect(ok).toBe(false);
    expect(result.current.preferences?.showSpam).toBe(false);
    expect(toast.error).toHaveBeenCalledWith("Failed to save", {
      description: "Encryption is not configured",
    });
    expect(toast.success).not.toHaveBeenCalled();
  });
});

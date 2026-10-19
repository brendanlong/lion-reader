/**
 * @vitest-environment jsdom
 */

/**
 * The AI settings sections: what the provider keys section says a key is
 * needed for, and the Change/Save/Cancel/Reset flow of
 * `EditablePreferenceField`, driven through the summarization settings.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { AiProviderKeySettings, SummarizationSettings } from "@/components/settings/ApiKeySettings";
import { procedureError } from "@/lib/trpc/handler-link";
import { renderWithTrpc, type ProcedureHandlers } from "../../../utils/component-test-helpers";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const PREFERENCES = {
  showSpam: false,
  canConfigureApiKeys: true,
  apiKeyProviders: [],
  unreadableApiKeyProviders: [],
  serverKeyProviders: [],
  summarizationModel: null,
  summarizationMaxWords: 120,
  summarizationPrompt: null,
  narrationModel: null,
};

function handlers(overrides: ProcedureHandlers = {}): ProcedureHandlers {
  return {
    "users.me.preferences": () => PREFERENCES,
    "users.me.updatePreferences": (input: { summarizationMaxWords?: number | null }) => ({
      ...PREFERENCES,
      ...input,
    }),
    "summarization.listModels": () => ({ models: [], defaultModelId: "m" }),
    "summarization.defaultPrompt": () => ({ prompt: "Summarize" }),
    ...overrides,
  };
}

async function startEditingMaxWords(): Promise<HTMLInputElement> {
  await screen.findByText("120");
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
  return screen.getByLabelText<HTMLInputElement>("Max words");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EditablePreferenceField (summarization max words)", () => {
  it("starts from the stored value and closes showing the saved one", async () => {
    const { callsFor } = renderWithTrpc(<SummarizationSettings />, { handlers: handlers() });

    const input = await startEditingMaxWords();
    expect(input.value).toBe("120");
    fireEvent.change(input, { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("250")).toBeInTheDocument();
    expect(screen.queryByLabelText("Max words")).toBeNull();
    expect(callsFor("users.me.updatePreferences")[0].input).toEqual({
      summarizationMaxWords: 250,
    });
  });

  it("shows a validation error at the input without saving", async () => {
    const { callsFor } = renderWithTrpc(<SummarizationSettings />, { handlers: handlers() });

    const input = await startEditingMaxWords();
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(input).toHaveAccessibleDescription("Max words must be a positive number");
    expect(callsFor("users.me.updatePreferences")).toHaveLength(0);
  });

  it("stays open with the draft when the save fails", async () => {
    const { callsFor } = renderWithTrpc(<SummarizationSettings />, {
      handlers: handlers({
        "users.me.updatePreferences": () => {
          throw procedureError("INTERNAL_SERVER_ERROR", "boom");
        },
      }),
    });

    const input = await startEditingMaxWords();
    fireEvent.change(input, { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(callsFor("users.me.updatePreferences")).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    expect(screen.getByLabelText<HTMLInputElement>("Max words").value).toBe("250");
  });

  it("discards the draft on Cancel", async () => {
    const { callsFor } = renderWithTrpc(<SummarizationSettings />, { handlers: handlers() });

    const input = await startEditingMaxWords();
    fireEvent.change(input, { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const reopened = await startEditingMaxWords();

    expect(reopened.value).toBe("120");
    expect(callsFor("users.me.updatePreferences")).toHaveLength(0);
  });

  it("resets a stored value to the default", async () => {
    const { callsFor } = renderWithTrpc(<SummarizationSettings />, { handlers: handlers() });

    await screen.findByText("120");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(await screen.findByText(/\(default\)/)).toBeInTheDocument();
    expect(callsFor("users.me.updatePreferences")[0].input).toEqual({
      summarizationMaxWords: null,
    });
    // Nothing left to reset.
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });
});

describe("AiProviderKeySettings", () => {
  const renderWithServerKeys = (serverKeyProviders: string[]) =>
    renderWithTrpc(<AiProviderKeySettings />, {
      handlers: handlers({
        "users.me.preferences": () => ({ ...PREFERENCES, serverKeyProviders }),
      }),
    });

  it.each([
    [[], "AI features need an API key from one of these providers."],
    [
      ["cerebras"],
      "You need your own key for cloud voices. Add one to use models that aren't available by default.",
    ],
    [
      ["anthropic", "deepinfra"],
      "You need your own key for narration. Add one to use models that aren't available by default.",
    ],
    [
      ["openrouter"],
      "AI features work without a key. Add your own to use models that aren't available by default.",
    ],
  ])("with server keys for %j, says: %s", async (serverKeyProviders, text) => {
    renderWithServerKeys(serverKeyProviders);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("says what each provider is used for", async () => {
    renderWithServerKeys([]);
    expect(await screen.findByText("(summaries, narration, cloud voices)")).toBeInTheDocument();
    expect(screen.getByText("(summaries)")).toBeInTheDocument();
  });
});

/**
 * @vitest-environment jsdom
 */

/**
 * Accessibility tests for the `role="switch"` toggles in NarrationSettings,
 * queried *by name* so each must be linked to its caption (#1550). The other
 * settings switches are covered in SettingsSwitches.test.tsx.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { NarrationSettings } from "@/components/narration/NarrationSettings";
import {
  renderWithTrpc,
  stubMemoryLocalStorage,
  type ProcedureHandlers,
} from "../../../utils/component-test-helpers";

// jsdom implements neither Web Speech API surface, and getNarrationSupportInfo
// gates the whole panel on speechSynthesis being present.
function stubSpeechSynthesis() {
  vi.stubGlobal("speechSynthesis", {
    getVoices: () => [],
    speak: vi.fn(),
    cancel: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      text = "";
    }
  );
}

const handlers: ProcedureHandlers = {
  "narration.isAiTextProcessingAvailable": () => ({ available: true }),
};

describe("NarrationSettings switches", () => {
  beforeEach(() => {
    stubMemoryLocalStorage();
    stubSpeechSynthesis();
  });

  // Narration defaults to enabled, so all four toggles render on first paint.
  const names = [
    /enable narration/i,
    /use ai text processing/i,
    /highlight current paragraph/i,
    /auto-scroll to current paragraph/i,
  ];

  it.each(names)("announces the %s switch with the caption it belongs to", async (name) => {
    renderWithTrpc(<NarrationSettings />, { handlers });

    const toggle = await screen.findByRole("switch", { name });
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).toHaveAttribute("type", "button");
  });

  it("reflects and flips the checked state of a named switch", async () => {
    renderWithTrpc(<NarrationSettings />, { handlers });

    const toggle = await screen.findByRole("switch", { name: /highlight current paragraph/i });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    expect(
      await screen.findByRole("switch", { name: /highlight current paragraph/i })
    ).not.toBeChecked();
  });
});

/**
 * @vitest-environment jsdom
 */

/**
 * Accessibility tests for the four hand-rolled `role="switch"` toggles in
 * NarrationSettings.
 *
 * Each is a button whose only child is an `aria-hidden` knob, with its visible
 * caption in an unlinked sibling element — so a screen reader announced
 * "switch, not checked" with no indication of what it toggles. The fix links
 * the caption with `aria-labelledby`; these tests query each switch *by name*,
 * which is precisely what failed before.
 *
 * The sibling toggles in EmailSettingsContent and KeyboardShortcutsSettings are
 * covered in SettingsSwitches.test.tsx. There is no shared `Switch` primitive
 * yet (issue #1550), so each site is covered separately.
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

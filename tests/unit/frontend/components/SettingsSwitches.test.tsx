/**
 * @vitest-environment jsdom
 */

/**
 * Accessibility tests for the `role="switch"` toggles in settings.
 *
 * A switch's only child is an `aria-hidden` knob, so it is named only by the
 * caption `SwitchRow` links with `aria-labelledby`. Without that link a screen
 * reader announced "switch, not checked" with no indication of what it toggles
 * (#1550); these tests query each switch *by name*.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import EmailSettingsContent from "@/components/settings/pages/EmailSettingsContent";
import { KeyboardShortcutsSettings } from "@/components/settings/KeyboardShortcutsSettings";
import { KeyboardShortcutsProvider } from "@/components/keyboard/KeyboardShortcutsProvider";
import {
  renderWithTrpc,
  stubMemoryLocalStorage,
  type ProcedureHandlers,
} from "../../../utils/component-test-helpers";

// sonner's toast is a side-effecting singleton (renders a portal); stub it so
// tests assert on component behavior, not the toast implementation.
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

describe("KeyboardShortcutsSettings toggle", () => {
  beforeEach(() => {
    stubMemoryLocalStorage();
  });

  function renderSettings() {
    return renderWithTrpc(
      <KeyboardShortcutsProvider>
        <KeyboardShortcutsSettings />
      </KeyboardShortcutsProvider>
    );
  }

  it("announces the switch with the heading it belongs to", () => {
    renderSettings();

    const toggle = screen.getByRole("switch", { name: /enable keyboard shortcuts/i });
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).toHaveAttribute("type", "button");
  });

  it("reflects and flips its checked state", () => {
    renderSettings();

    const toggle = screen.getByRole("switch", { name: /enable keyboard shortcuts/i });
    // Shortcuts default to enabled.
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    expect(screen.getByRole("switch", { name: /enable keyboard shortcuts/i })).not.toBeChecked();
  });
});

describe("EmailSettingsContent spam preference toggle", () => {
  const handlers: ProcedureHandlers = {
    "ingestAddresses.list": () => ({ enabled: true, items: [] }),
    "users.me.preferences": () => ({ showSpam: false }),
    "users.me.updatePreferences": () => ({ showSpam: true }),
  };

  it("announces the switch with the heading it belongs to", async () => {
    renderWithTrpc(<EmailSettingsContent />, { handlers });

    const toggle = await screen.findByRole("switch", { name: /show spam entries/i });
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle).toHaveAttribute("type", "button");
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).not.toBeChecked();
  });

  it("toggling it sends the preference update", async () => {
    const { callsFor } = renderWithTrpc(<EmailSettingsContent />, { handlers });

    const toggle = await screen.findByRole("switch", { name: /show spam entries/i });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);

    await waitFor(() => expect(callsFor("users.me.updatePreferences")).toHaveLength(1));
    expect(callsFor("users.me.updatePreferences")[0].input).toEqual({ showSpam: true });
  });
});

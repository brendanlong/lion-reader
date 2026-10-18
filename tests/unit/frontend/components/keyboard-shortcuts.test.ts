/**
 * The help modal derives its key chips from the `hotkey` strings the bindings
 * register, so a wrong label would misdescribe a working shortcut.
 */

import { describe, it, expect } from "vitest";
import { formatHotkey, hotkeyAlternatives } from "@/components/keyboard/shortcuts";

describe("hotkeyAlternatives", () => {
  it("splits and normalizes the alternatives the way react-hotkeys-hook reports them", () => {
    expect(hotkeyAlternatives("o, Enter")).toEqual(["o", "enter"]);
  });
});

describe("formatHotkey", () => {
  it.each([
    ["j", "j"],
    ["shift+j", "Shift+J"],
    ["escape", "Escape"],
    ["/", "/"],
    // The produced character already implies Shift.
    ["shift+?", "?"],
  ])("shows %s as %s", (hotkey, label) => {
    expect(formatHotkey(hotkey)).toBe(label);
  });
});

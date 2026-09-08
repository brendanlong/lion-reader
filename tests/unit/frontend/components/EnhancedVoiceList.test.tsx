/**
 * @vitest-environment jsdom
 */

/**
 * Accessibility tests for the enhanced (Piper) voice picker.
 *
 * The list used to fake a radio group: `role="radio"` on each card with no
 * owning `radiogroup`, no accessible name on the radio itself, and
 * `tabIndex={0}` on every card (so every voice was its own tab stop). It is now
 * a `role="radiogroup"` of real `<input type="radio">`s sharing one `name`,
 * matching the sibling browser-voice panel — which is what gives it a single
 * tab stop and browser-native arrow-key navigation.
 *
 * Arrow-key traversal itself is browser behavior that jsdom does not implement,
 * so what is asserted here is the markup that earns it: one named radiogroup,
 * one shared radio `name`, real radio elements, and selection through them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// The Piper module is a browser-only dependency (OPFS/WASM). Stubbing `stored()`
// is what lets the list render voices in the "downloaded" (selectable) state.
const { mockStored } = vi.hoisted(() => ({ mockStored: vi.fn() }));

vi.mock("@mintplex-labs/piper-tts-web", () => ({
  TtsSession: { create: vi.fn() },
  download: vi.fn(),
  remove: vi.fn(),
  stored: mockStored,
  flush: vi.fn(),
}));

import { EnhancedVoiceList } from "@/components/narration/EnhancedVoiceList";
import { DEFAULT_NARRATION_SETTINGS, type NarrationSettings } from "@/lib/narration/settings";
import { ENHANCED_VOICES } from "@/lib/narration/enhanced-voices";

const FIRST = ENHANCED_VOICES[0];
const SECOND = ENHANCED_VOICES[1];

function renderList(overrides: Partial<NarrationSettings> = {}) {
  const setSettings = vi.fn();
  const settings: NarrationSettings = {
    ...DEFAULT_NARRATION_SETTINGS,
    provider: "piper",
    ...overrides,
  };
  const result = render(<EnhancedVoiceList settings={settings} setSettings={setSettings} />);
  return { ...result, setSettings, settings };
}

describe("EnhancedVoiceList radio group", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Both voices downloaded, so both are selectable.
    mockStored.mockResolvedValue([FIRST.id, SECOND.id]);
  });

  it("wraps the voices in a radiogroup with an accessible name", async () => {
    renderList();

    const group = await screen.findByRole("radiogroup", { name: "Enhanced voices" });
    expect(group).toBeInTheDocument();
  });

  it("gives every voice a real radio with the voice's name", async () => {
    renderList();

    const radio = await screen.findByRole("radio", { name: FIRST.displayName });
    expect(radio.tagName).toBe("INPUT");
    expect(radio).toHaveAttribute("type", "radio");
    expect(screen.getByRole("radio", { name: SECOND.displayName })).toBeInTheDocument();
  });

  it("puts every radio in one native group, which is what makes it a single tab stop", async () => {
    renderList();

    await screen.findByRole("radiogroup", { name: "Enhanced voices" });
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(ENHANCED_VOICES.length);

    const names = new Set(radios.map((r) => r.name));
    expect(names.size).toBe(1);

    // The old markup put `tabIndex={0}` on each card; nothing may override the
    // radio group's native roving tab behavior.
    for (const radio of radios) {
      expect(radio).not.toHaveAttribute("tabindex");
    }
  });

  it("marks the selected voice checked", async () => {
    renderList({ voiceId: SECOND.id });

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: SECOND.displayName })).toBeChecked()
    );
    expect(screen.getByRole("radio", { name: FIRST.displayName })).not.toBeChecked();
  });

  it("selects a voice through the radio itself", async () => {
    const { setSettings } = renderList();

    const radio = await screen.findByRole("radio", { name: SECOND.displayName });
    fireEvent.click(radio);

    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ voiceId: SECOND.id }));
  });

  it("selects a voice when its label is clicked", async () => {
    const { setSettings } = renderList();

    await screen.findByRole("radio", { name: FIRST.displayName });
    fireEvent.click(screen.getByText(FIRST.displayName));

    expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ voiceId: FIRST.id }));
  });

  it("disables voices that are not downloaded yet", async () => {
    mockStored.mockResolvedValue([FIRST.id]);
    renderList();

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: FIRST.displayName })).toBeEnabled()
    );
    expect(screen.getByRole("radio", { name: SECOND.displayName })).toBeDisabled();
  });
});

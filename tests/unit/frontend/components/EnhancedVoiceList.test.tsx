/**
 * @vitest-environment jsdom
 */

/**
 * The enhanced voice picker: one shared model download gates every voice, and
 * the voices are a real radio group (one named `radiogroup` of `<input
 * type="radio">`s sharing a `name`), which is what gives it a single tab stop
 * and browser-native arrow-key navigation. jsdom doesn't implement that
 * traversal, so the markup that earns it is what's asserted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  createMemoryCacheStorage,
  type MemoryCacheStorage,
} from "../../../utils/memory-cache-storage";

// The package runs a wasm model in a worker, which jsdom can't.
vi.mock("phonon-tts", () => ({ PhononTTS: { load: vi.fn() } }));

import { EnhancedVoiceList } from "@/components/narration/EnhancedVoiceList";
import { DEFAULT_NARRATION_SETTINGS, type NarrationSettings } from "@/lib/narration/settings";
import { ENHANCED_VOICES, resolveEnhancedVoice } from "@/lib/narration/enhanced-voices";
import { removePhononModel } from "@/lib/narration/phonon-tts";

const DEFAULT_VOICE = resolveEnhancedVoice(null);
const OTHER = ENHANCED_VOICES.find((voice) => voice.id !== DEFAULT_VOICE.id)!;

function renderList(overrides: Partial<NarrationSettings> = {}) {
  const setSettings = vi.fn();
  const settings: NarrationSettings = {
    ...DEFAULT_NARRATION_SETTINGS,
    provider: "phonon",
    ...overrides,
  };
  const result = render(<EnhancedVoiceList settings={settings} setSettings={setSettings} />);
  return { ...result, setSettings };
}

async function downloadModel() {
  fireEvent.click(await screen.findByRole("button", { name: "Download" }));
  await screen.findByText("Downloaded");
}

describe("EnhancedVoiceList", () => {
  let storage: MemoryCacheStorage;

  beforeEach(async () => {
    storage = createMemoryCacheStorage();
    vi.stubGlobal("caches", storage);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("model bytes"))
    );
    await removePhononModel();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("puts every voice in one native radio group, named for its voice", async () => {
    renderList();

    await screen.findByRole("radiogroup", { name: "Enhanced voices" });
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios).toHaveLength(ENHANCED_VOICES.length);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    for (const radio of radios) {
      expect(radio.tagName).toBe("INPUT");
      expect(radio).not.toHaveAttribute("tabindex");
    }
    expect(screen.getByRole("radio", { name: OTHER.name })).toBeInTheDocument();
  });

  it("disables every voice until the model is downloaded", async () => {
    renderList();

    expect(await screen.findByRole("radio", { name: OTHER.name })).toBeDisabled();
    await downloadModel();
    expect(screen.getByRole("radio", { name: OTHER.name })).toBeEnabled();
  });

  it("remembers the download across renders", async () => {
    const { unmount } = renderList();
    await downloadModel();
    unmount();

    renderList();
    expect(await screen.findByText("Downloaded")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: OTHER.name })).toBeEnabled();
  });

  it("checks the default voice when none is picked, and the picked one otherwise", async () => {
    const { unmount } = renderList({ voiceId: null });
    expect(await screen.findByRole("radio", { name: DEFAULT_VOICE.name })).toBeChecked();
    unmount();

    renderList({ voiceId: OTHER.id });
    expect(await screen.findByRole("radio", { name: OTHER.name })).toBeChecked();
    expect(screen.getByRole("radio", { name: DEFAULT_VOICE.name })).not.toBeChecked();
  });

  it("selects a voice through its radio or its label", async () => {
    const { setSettings } = renderList();
    await downloadModel();

    fireEvent.click(screen.getByRole("radio", { name: OTHER.name }));
    expect(setSettings).toHaveBeenLastCalledWith(expect.objectContaining({ voiceId: OTHER.id }));

    fireEvent.click(screen.getByText(DEFAULT_VOICE.name));
    expect(setSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ voiceId: DEFAULT_VOICE.id })
    );
  });

  it("deletes the model's files and disables the voices again", async () => {
    renderList();
    await downloadModel();

    fireEvent.click(screen.getByRole("button", { name: "Delete voice model" }));

    expect(await screen.findByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(storage.storedUrls()).toEqual([]);
    expect(screen.getByRole("radio", { name: OTHER.name })).toBeDisabled();
  });
});

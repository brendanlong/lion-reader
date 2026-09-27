/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ModelPicker } from "@/components/settings/ModelPicker";
import type { PickerModel } from "@/lib/ai/model-picker";

const models: PickerModel[] = [
  { id: "cerebras:gpt-oss-120b", displayName: "gpt-oss-120b", provider: "cerebras" },
  {
    id: "openrouter:openai/gpt-oss-120b",
    displayName: "OpenAI: gpt-oss-120b",
    provider: "openrouter",
  },
  {
    id: "openrouter:google/gemini-3.8-flash",
    displayName: "Google: Gemini 3.8 Flash",
    provider: "openrouter",
  },
];

beforeAll(() => {
  // jsdom doesn't implement layout.
  Element.prototype.scrollIntoView = () => {};
});

function renderPicker(onChange = vi.fn()) {
  render(
    <ModelPicker
      id="model"
      value="cerebras:gpt-oss-120b"
      defaultModelId="cerebras:gpt-oss-120b"
      models={models}
      suggestedModelIds={["openrouter:google/gemini-3.8-flash"]}
      isLoading={false}
      disabled={false}
      onChange={onChange}
    />
  );
  return { input: screen.getByRole("combobox"), onChange };
}

describe("ModelPicker", () => {
  it("shows the selected model's name while closed", () => {
    const { input } = renderPicker();
    expect(input).toHaveValue("gpt-oss-120b");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("opens with suggestions first and the current model marked", () => {
    const { input } = renderPicker();
    fireEvent.focus(input);
    const suggested = screen.getByRole("group", { name: "Suggested" });
    expect(
      within(suggested)
        .getAllByRole("option")
        .map((option) => option.textContent)
    ).toEqual([
      expect.stringContaining("gpt-oss-120b (default)"),
      expect.stringContaining("Google: Gemini 3.8 Flash"),
    ]);
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("gpt-oss-120b");
  });

  it("filters by search and selects with the keyboard", () => {
    const { input, onChange } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "openai" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("openrouter:openai/gpt-oss-120b");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("moves the active option with the arrow keys", () => {
    const { input, onChange } = renderPicker();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "model-option-1");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("openrouter:google/gemini-3.8-flash");
  });

  it("selects on click and closes without changing on Escape", () => {
    const { input, onChange } = renderPicker();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(input);
    fireEvent.click(screen.getByRole("option", { name: /Gemini/ }));
    expect(onChange).toHaveBeenCalledWith("openrouter:google/gemini-3.8-flash");
  });

  it("says so when nothing matches", () => {
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "no such model" } });
    expect(screen.getByText("No matching models")).toBeInTheDocument();
  });
});

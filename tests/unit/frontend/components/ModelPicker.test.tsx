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

function renderPicker(onChange = vi.fn(), value: string | null = "cerebras:gpt-oss-120b") {
  render(
    <ModelPicker
      id="model"
      value={value}
      defaultModelId="cerebras:gpt-oss-120b"
      models={models}
      suggestedModelIds={["openrouter:google/gemini-3.8-flash"]}
      isLoading={false}
      onChange={onChange}
    />
  );
  return { input: screen.getByRole("combobox"), onChange };
}

describe("ModelPicker", () => {
  it("shows the selected model's name while closed", () => {
    const { input } = renderPicker();
    expect(input).toHaveValue("gpt-oss-120b · Cerebras");
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
      expect.stringContaining("gpt-oss-120b"),
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
    expect(input).toHaveAttribute("aria-activedescendant", "model-option-2");
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

  it("opens on the selected model and supports Home/End", () => {
    render(
      <ModelPicker
        id="model"
        value="openrouter:openai/gpt-oss-120b"
        defaultModelId="cerebras:gpt-oss-120b"
        models={models}
        suggestedModelIds={[]}
        isLoading={false}
        onChange={vi.fn()}
      />
    );
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input).toHaveAttribute("aria-activedescendant", "model-option-2");
    fireEvent.keyDown(input, { key: "End" });
    expect(input).toHaveAttribute("aria-activedescendant", "model-option-3");
    fireEvent.keyDown(input, { key: "Home" });
    expect(input).toHaveAttribute("aria-activedescendant", "model-option-0");
  });

  it("follows the default when nothing is picked", () => {
    const { input } = renderPicker(vi.fn(), null);
    expect(input).toHaveValue("Default (gpt-oss-120b · Cerebras)");
    fireEvent.focus(input);
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
      "Default (gpt-oss-120b · Cerebras)"
    );
    expect(input).toHaveAttribute("aria-activedescendant", "model-option-0");
  });

  it("goes back to the default from a picked model, and hides it while searching", () => {
    const { input, onChange } = renderPicker();
    fireEvent.focus(input);
    expect(screen.getAllByRole("option")[0]).toHaveTextContent("Default (gpt-oss-120b · Cerebras)");
    fireEvent.click(screen.getByRole("option", { name: /^Default/ }));
    expect(onChange).toHaveBeenCalledWith(null);

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "gpt" } });
    expect(screen.queryByRole("option", { name: /^Default/ })).not.toBeInTheDocument();
  });

  it("says so when nothing matches", () => {
    const { input } = renderPicker();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "no such model" } });
    expect(screen.getByRole("status")).toHaveTextContent("No matching models");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

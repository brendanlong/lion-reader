/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for the searchable Combobox.
 *
 * The AI model pickers feed it several hundred OpenRouter models (#1416), so
 * the behavior that matters is filtering, the truncation notice, keyboard
 * selection, and not silently changing the value on cancel.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";

// jsdom implements neither of these, and the component calls both.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  if (!("PointerEvent" in globalThis)) {
    // fireEvent.pointerDown needs a constructible PointerEvent.
    Object.defineProperty(globalThis, "PointerEvent", { value: MouseEvent, writable: true });
  }
});

const OPTIONS: ComboboxOption[] = [
  { value: "cerebras:gpt-oss-120b", label: "gpt-oss-120b", group: "Cerebras" },
  { value: "openrouter:openai/gpt-oss-120b", label: "OpenAI: gpt-oss-120b", group: "OpenRouter" },
  { value: "openrouter:anthropic/claude-opus-5", label: "Claude Opus 5", group: "OpenRouter" },
];

function renderCombobox(props: Partial<React.ComponentProps<typeof Combobox>> = {}) {
  const onChange = vi.fn();
  render(
    <Combobox
      id="model"
      value="cerebras:gpt-oss-120b"
      options={OPTIONS}
      onChange={onChange}
      {...props}
    />
  );
  return { onChange, input: screen.getByRole("combobox") };
}

describe("Combobox", () => {
  it("shows the selected option's label while closed", () => {
    const { input } = renderCombobox();
    expect(input).toHaveValue("gpt-oss-120b");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("falls back to the raw value when the selection isn't in the list", () => {
    const { input } = renderCombobox({ value: "openrouter:some/unlisted-model" });
    expect(input).toHaveValue("openrouter:some/unlisted-model");
  });

  it("opens on focus and lists every option", () => {
    const { input } = renderCombobox();
    fireEvent.focus(input);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("filters by label, by stored value, and by every typed term", () => {
    const { input } = renderCombobox();
    fireEvent.focus(input);

    fireEvent.change(input, { target: { value: "claude" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Claude Opus 5"]);

    // The provider-qualified value isn't displayed but is searchable.
    fireEvent.change(input, { target: { value: "cerebras" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["gpt-oss-120b"]);

    // Terms are ANDed and order-independent.
    fireEvent.change(input, { target: { value: "oss openai" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "OpenAI: gpt-oss-120b",
    ]);
  });

  it("reports when the search matches nothing", () => {
    const { input } = renderCombobox({ emptyMessage: "No models match" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "zzzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No models match")).toBeInTheDocument();
  });

  it("caps the rendered list and says how many are hidden", () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      value: `openrouter:model-${index}`,
      label: `Model ${index}`,
    }));
    const { input } = renderCombobox({ options: many, value: "openrouter:model-0" });
    fireEvent.focus(input);
    expect(screen.getAllByRole("option")).toHaveLength(50);
    expect(screen.getByText(/70 more matches/)).toBeInTheDocument();
  });

  it("selects with pointer and closes", () => {
    const { onChange, input } = renderCombobox();
    fireEvent.focus(input);
    fireEvent.pointerDown(screen.getByText("Claude Opus 5"));
    expect(onChange).toHaveBeenCalledWith("openrouter:anthropic/claude-opus-5");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("selects with arrow keys and Enter", () => {
    const { onChange, input } = renderCombobox();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("openrouter:openai/gpt-oss-120b");
  });

  it("does not fire onChange when the current value is re-picked", () => {
    const { onChange, input } = renderCombobox();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("restores the selected label and fires nothing on Escape", () => {
    const { onChange, input } = renderCombobox();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "claude" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("gpt-oss-120b");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("marks the current value as the selected option", () => {
    const { input } = renderCombobox();
    fireEvent.focus(input);
    const selected = screen.getAllByRole("option").filter((o) => o.ariaSelected === "true");
    expect(selected.map((o) => o.textContent)).toEqual(["gpt-oss-120b"]);
  });

  it("is inert and shows a loading label while models load", () => {
    const { input } = renderCombobox({ isLoading: true, loadingLabel: "Loading models…" });
    expect(input).toBeDisabled();
    expect(input).toHaveValue("Loading models…");
    fireEvent.focus(input);
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("does not suppress the global focus outline (#1292)", () => {
    const { input } = renderCombobox();
    expect(input.className).not.toMatch(/focus:/);
  });
});

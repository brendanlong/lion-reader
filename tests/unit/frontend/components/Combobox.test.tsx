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
  const element = (overrides: Partial<React.ComponentProps<typeof Combobox>>) => (
    <Combobox
      id="model"
      value="cerebras:gpt-oss-120b"
      options={OPTIONS}
      onChange={onChange}
      {...props}
      {...overrides}
    />
  );
  const { rerender } = render(element({}));
  return {
    onChange,
    input: screen.getByRole("combobox"),
    /** Re-renders with a different options list, as a refetch would. */
    rerenderOptions: (options: ComboboxOption[]) => rerender(element({ options })),
  };
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

  it("keeps the query when the input is clicked again while open", () => {
    const { input } = renderCombobox();
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "claude" } });
    // Clicking back into the input (e.g. to move the cursor) must not reopen
    // and wipe what the user has typed.
    fireEvent.click(input);
    expect(input).toHaveValue("claude");
    expect(screen.getAllByRole("option")).toHaveLength(1);
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
    fireEvent.click(screen.getByText("Claude Opus 5"));
    expect(onChange).toHaveBeenCalledWith("openrouter:anthropic/claude-opus-5");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("does not select on touch-down, so the list can be flick-scrolled", () => {
    const { onChange } = renderCombobox();
    fireEvent.focus(screen.getByRole("combobox"));
    // A touch landing on an option must not pick it; only the completed tap
    // (click) does. Pointerdown is still cancelled, to hold input focus.
    const option = screen.getByText("Claude Opus 5");
    const notCancelled = fireEvent.pointerDown(option);
    expect(onChange).not.toHaveBeenCalled();
    expect(notCancelled).toBe(false);
  });

  it("clamps the active option when the list shrinks underneath it", () => {
    // The options prop refetches while the listbox is open (React Query
    // refocus), so a stored index can point past the end of the new list.
    const { onChange, input, rerenderOptions } = renderCombobox({
      value: "openrouter:anthropic/claude-opus-5",
    });
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "End" }); // index 2 of 3
    rerenderOptions(OPTIONS.slice(0, 1)); // now only 1 option exists
    fireEvent.keyDown(input, { key: "Enter" });
    // Falls back to the first option rather than silently doing nothing.
    expect(onChange).toHaveBeenCalledWith("cerebras:gpt-oss-120b");
  });

  it("jumps to the first and last option with Home and End", () => {
    const { onChange, input } = renderCombobox();
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "End" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("openrouter:anthropic/claude-opus-5");
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

  it("keeps the listbox's accessibility tree to groups and options", () => {
    const { input } = renderCombobox();
    fireEvent.focus(input);
    const listbox = screen.getByRole("listbox");
    // A listbox may only contain groups and options, so the status messages
    // live outside it and group headings carry role="group".
    expect([...listbox.children].every((child) => child.getAttribute("role") === "group")).toBe(
      true
    );
    expect(screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"))).toEqual([
      "Cerebras",
      "OpenRouter",
    ]);
  });

  it("keeps the status messages outside the listbox", () => {
    // Same rule: neither the truncation notice nor the empty-state message may
    // sit inside the listbox, where only groups and options are allowed.
    const many = Array.from({ length: 60 }, (_, index) => ({
      value: `openrouter:model-${index}`,
      label: `Model ${index}`,
    }));
    const { input } = renderCombobox({ options: many, value: "openrouter:model-0" });
    fireEvent.focus(input);
    expect(screen.getByRole("listbox")).not.toContainElement(screen.getByText(/10 more matches/));

    fireEvent.change(input, { target: { value: "zzzz" } });
    expect(screen.getByRole("listbox")).not.toContainElement(screen.getByText("No matches"));
  });

  it("points aria-controls at the listbox only while it exists", () => {
    const { input } = renderCombobox();
    expect(input).not.toHaveAttribute("aria-controls");
    fireEvent.focus(input);
    expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
  });

  it("does not suppress the global focus outline (#1292)", () => {
    const { input } = renderCombobox();
    expect(input.className).not.toMatch(/focus:/);
  });
});

/**
 * Combobox
 *
 * A single-select dropdown with type-to-filter search, for lists too long for a
 * native `<select>` — OpenRouter alone contributes several hundred models to
 * the AI model pickers (issue #1416).
 *
 * Follows the ARIA combobox pattern: a text input owns the search query, an
 * anchored listbox shows the matches, and the active option is tracked with
 * `aria-activedescendant` so focus never leaves the input.
 */

"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

export interface ComboboxOption {
  value: string;
  label: string;
  /** Optional heading the option is listed under. */
  group?: string;
  /** Extra text matched by the search but not displayed. */
  keywords?: string;
}

/**
 * Rendering every match would mean hundreds of DOM nodes per keystroke, and a
 * list that long is useless to scroll anyway — past this many the user is told
 * to keep typing.
 */
const MAX_VISIBLE_OPTIONS = 50;

/**
 * Matches an option against a query: every whitespace-separated term must
 * appear somewhere in the label, value, or keywords. Term-wise (rather than
 * whole-string) matching lets "claude opus" find "Anthropic: Claude Opus 5"
 * and "opus claude" find it too.
 */
function matchesQuery(option: ComboboxOption, terms: string[]): boolean {
  if (terms.length === 0) {
    return true;
  }
  const haystack =
    `${option.label} ${option.value} ${option.group ?? ""} ${option.keywords ?? ""}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export interface ComboboxProps {
  id: string;
  /** Currently selected value (may be absent from `options`). */
  value: string;
  options: ComboboxOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  isLoading?: boolean;
  placeholder?: string;
  /** Shown when the search matches nothing. */
  emptyMessage?: string;
  /** Accessible name for the listbox. */
  listLabel?: string;
  /** Shown in place of the selection while `isLoading`. */
  loadingLabel?: string;
  "aria-describedby"?: string;
}

export function Combobox({
  id,
  value,
  options,
  onChange,
  disabled = false,
  isLoading = false,
  placeholder = "Search…",
  emptyMessage = "No matches",
  listLabel = "Options",
  loadingLabel = "Loading…",
  "aria-describedby": ariaDescribedBy,
}: ComboboxProps) {
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Raw because it may point past a list that shrank underneath it; read the
  // clamped `activeIndex` below instead.
  const [rawActiveIndex, setActiveIndex] = useState(0);

  const selectedOption = options.find((option) => option.value === value);
  // While closed the input displays the selection; typing replaces it with the
  // query, and closing without choosing restores it.
  const selectedLabel = selectedOption?.label ?? value;

  const matches = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return options.filter((option) => matchesQuery(option, terms));
  }, [options, query]);

  const visible = matches.slice(0, MAX_VISIBLE_OPTIONS);
  const hiddenCount = matches.length - visible.length;

  // The stored index can outlive the list it indexed — `options` refetches
  // while the listbox is open — so clamp rather than trusting it. Everything
  // below (highlight, aria-activedescendant, Enter) uses the clamped value.
  const activeIndex = rawActiveIndex < visible.length ? rawActiveIndex : 0;
  const activeOption = visible[activeIndex];

  // Consecutive runs of options that share a group, for the `role="group"`
  // headings. Built from the already-capped `visible` slice, so ≤50 items.
  const groups: {
    label: string | undefined;
    items: { option: ComboboxOption; index: number }[];
  }[] = [];
  visible.forEach((option, index) => {
    const last = groups[groups.length - 1];
    if (last && last.label === option.group) {
      last.items.push({ option, index });
    } else {
      groups.push({ label: option.group, items: [{ option, index }] });
    }
  });

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
  }, []);

  const open = useCallback(() => {
    // Already-open is a no-op: focus and click both call this, so re-opening
    // would wipe a query the user is in the middle of typing whenever they
    // click back into the input to move the cursor.
    if (disabled || isLoading || isOpen) {
      return;
    }
    setIsOpen(true);
    setQuery("");
    // Start on the current selection so Enter re-picks it rather than jumping.
    // With an empty query the visible slice is just the first
    // MAX_VISIBLE_OPTIONS options, so a selection past that isn't on screen.
    const selectedIndex = options.findIndex((option) => option.value === value);
    setActiveIndex(selectedIndex >= 0 && selectedIndex < MAX_VISIBLE_OPTIONS ? selectedIndex : 0);
  }, [disabled, isLoading, isOpen, options, value]);

  const select = useCallback(
    (option: ComboboxOption) => {
      close();
      if (option.value !== value) {
        onChange(option.value);
      }
    },
    [close, onChange, value]
  );

  // Close on outside click. Pointerdown (not click) so the list can't be left
  // open behind a control the user is already interacting with.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [isOpen, close]);

  // Keep the active option scrolled into view during keyboard navigation.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [isOpen, activeIndex]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (!isOpen) {
          open();
          return;
        }
        if (visible.length === 0) {
          return;
        }
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((activeIndex + delta + visible.length) % visible.length);
        return;
      }
      case "Home":
      case "End": {
        if (!isOpen || visible.length === 0) {
          return;
        }
        event.preventDefault();
        setActiveIndex(event.key === "Home" ? 0 : visible.length - 1);
        return;
      }
      case "Enter": {
        if (!isOpen) {
          return;
        }
        event.preventDefault();
        if (activeOption) {
          select(activeOption);
        }
        return;
      }
      case "Escape": {
        if (isOpen) {
          event.preventDefault();
          close();
        }
        return;
      }
      case "Tab": {
        close();
        return;
      }
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        // Only while open: the listbox is unmounted when closed, and a dangling
        // aria-controls points at nothing.
        aria-controls={isOpen ? listboxId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={isOpen && activeOption ? `${listboxId}-${activeIndex}` : undefined}
        aria-describedby={ariaDescribedBy}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled || isLoading}
        value={isOpen ? query : isLoading ? loadingLabel : selectedLabel}
        placeholder={placeholder}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
          setIsOpen(true);
        }}
        onFocus={open}
        onClick={open}
        onKeyDown={handleKeyDown}
        className="ui-text-sm bg-surface text-body placeholder:text-faint border-edge-input block w-full rounded-md border px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50"
      />
      {isOpen && (
        <div className="bg-surface border-edge-strong absolute z-20 mt-1 w-full rounded-md border shadow-lg">
          {/* The listbox holds nothing but groups and options — the status
              messages below are siblings, not children, so the accessibility
              tree stays valid. */}
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={listLabel}
            className="max-h-72 overflow-y-auto py-1"
          >
            {groups.map((group) => (
              <div key={group.label ?? "__ungrouped"} role="group" aria-label={group.label}>
                {group.label !== undefined && (
                  <div
                    aria-hidden="true"
                    className="ui-text-xs text-faint px-3 pt-2 pb-1 font-medium"
                  >
                    {group.label}
                  </div>
                )}
                {group.items.map(({ option, index }) => (
                  <div
                    key={option.value}
                    id={`${listboxId}-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={option.value === value}
                    // preventDefault on pointerdown keeps focus in the input
                    // (so the outside-pointerdown close can't race the pick),
                    // but the pick itself waits for click — selecting on
                    // pointerdown would fire the moment a touch lands, making
                    // the list impossible to flick-scroll on a phone.
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => select(option)}
                    onPointerEnter={() => setActiveIndex(index)}
                    className={`ui-text-sm text-body control-outline-none cursor-pointer px-3 py-2 ${
                      index === activeIndex ? "bg-surface-muted control-outline" : ""
                    }`}
                  >
                    {option.label}
                  </div>
                ))}
              </div>
            ))}
          </div>
          {/* Announced, because a search that matches nothing or silently drops
              results is otherwise invisible to a screen reader. */}
          <div aria-live="polite">
            {visible.length === 0 && (
              <div className="ui-text-sm text-muted px-3 py-2">{emptyMessage}</div>
            )}
            {hiddenCount > 0 && (
              <div className="border-edge ui-text-xs text-faint border-t px-3 py-2">
                {hiddenCount} more match{hiddenCount === 1 ? "" : "es"} — keep typing to narrow the
                list
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

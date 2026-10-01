/**
 * Searchable model picker (ARIA combobox) for AI settings. Provider catalogs
 * like OpenRouter's list hundreds of models, so suggested models lead and
 * search covers the rest. The first option, "Default", follows the server's
 * default instead of pinning today's default model.
 */

"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CheckIcon, ChevronDownIcon } from "@/components/ui/icons";
import {
  buildModelPickerSections,
  formatModelDetails,
  formatModelName,
  type PickerModel,
} from "@/lib/ai/model-picker";

interface ModelPickerProps {
  id: string;
  /** The selected `provider:model` ref, or null to follow the default. */
  value: string | null;
  defaultModelId: string;
  models: PickerModel[];
  suggestedModelIds: string[];
  isLoading: boolean;
  onChange: (value: string | null) => void;
}

export function ModelPicker({
  id,
  value,
  defaultModelId,
  models,
  suggestedModelIds,
  isLoading,
  onChange,
}: ModelPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // Only keyboard moves scroll the active option into view; scrolling on
  // hover would move the list under the pointer.
  const scrollToActiveRef = useRef(false);

  const sections = useMemo(
    () => buildModelPickerSections(models, { query, suggestedModelIds, defaultModelId }),
    [models, query, suggestedModelIds, defaultModelId]
  );
  // null is the "Default" option, listed first unless searching.
  const showDefault = query.trim() === "";
  const options = useMemo(
    () => [...(showDefault ? [null] : []), ...sections.flatMap((section) => section.models)],
    [showDefault, sections]
  );
  const active = Math.max(0, Math.min(activeIndex, options.length - 1));

  const listboxId = `${id}-listbox`;
  const optionId = (index: number) => `${id}-option-${index}`;
  const defaultModel = models.find((model) => model.id === defaultModelId);
  const defaultLabel = `Default (${defaultModel ? formatModelName(defaultModel) : defaultModelId})`;
  const selected = models.find((model) => model.id === value);
  const selectedLabel = isLoading
    ? "Loading models..."
    : value === null
      ? defaultLabel
      : selected
        ? formatModelName(selected)
        : value;

  useEffect(() => {
    if (isOpen && scrollToActiveRef.current) {
      scrollToActiveRef.current = false;
      document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [isOpen, active, id]);

  const moveTo = (index: number) => {
    scrollToActiveRef.current = true;
    setActiveIndex(index);
  };

  const open = () => {
    const unfiltered = buildModelPickerSections(models, {
      query: "",
      suggestedModelIds,
      defaultModelId,
    }).flatMap((section) => section.models);
    setQuery("");
    // + 1 for the Default option; a value missing from the list (-1) lands on it.
    moveTo(value === null ? 0 : unfiltered.findIndex((model) => model.id === value) + 1);
    setIsOpen(true);
  };

  const select = (option: PickerModel | null) => {
    setIsOpen(false);
    const next = option?.id ?? null;
    if (next !== value) {
      onChange(next);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        open();
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveTo(Math.min(active + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        moveTo(Math.max(active - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        moveTo(0);
        break;
      case "End":
        event.preventDefault();
        moveTo(options.length - 1);
        break;
      case "Enter":
        if (active < options.length) {
          event.preventDefault();
          select(options[active]);
        }
        break;
      case "Escape":
        event.preventDefault();
        setIsOpen(false);
        break;
    }
  };

  const firstModelIndex = showDefault ? 1 : 0;
  const sectionOffsets = sections.map(
    (_, sectionIndex) =>
      firstModelIndex +
      sections.slice(0, sectionIndex).reduce((count, section) => count + section.models.length, 0)
  );

  const renderOption = (
    option: PickerModel | null,
    index: number,
    label: string,
    details: string
  ) => {
    const isSelected = (option?.id ?? null) === value;
    return (
      <div
        key={option?.id ?? "default"}
        id={optionId(index)}
        role="option"
        aria-selected={isSelected}
        onClick={() => select(option)}
        onMouseMove={() => setActiveIndex(index)}
        className={`flex cursor-pointer items-start gap-2 px-3 py-2 ${
          index === active ? "control-outline bg-surface-muted" : "control-outline-none"
        }`}
      >
        <span className="mt-0.5 w-4 flex-shrink-0">
          {isSelected && <CheckIcon className="text-body h-4 w-4" />}
        </span>
        <span className="min-w-0">
          <span className="ui-text-sm text-body block">{label}</span>
          <span className="ui-text-xs text-muted block break-words">{details}</span>
        </span>
      </div>
    );
  };

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={isOpen && options.length > 0 ? optionId(active) : undefined}
        autoComplete="off"
        spellCheck={false}
        value={isOpen ? query : selectedLabel}
        placeholder={isOpen ? `Search models (current: ${selectedLabel})` : undefined}
        onFocus={open}
        onClick={() => {
          if (!isOpen) open();
        }}
        onBlur={() => setIsOpen(false)}
        onChange={(e) => {
          setQuery(e.target.value);
          moveTo(0);
          setIsOpen(true);
        }}
        onKeyDown={handleKeyDown}
        disabled={isLoading}
        className="ui-text-sm bg-surface text-body placeholder:text-faint border-edge-input block w-full rounded-md border py-2 pr-9 pl-3 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <ChevronDownIcon className="text-faint pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2" />
      {isOpen && (
        <div
          // Keep focus in the input so blur doesn't close the list before a
          // click (or a scrollbar drag) lands.
          onMouseDown={(e) => e.preventDefault()}
          className="bg-surface border-edge-input absolute z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-md border shadow-lg"
        >
          {options.length === 0 && (
            <p role="status" className="ui-text-sm text-muted px-3 py-2">
              No matching models
            </p>
          )}
          <div id={listboxId} role="listbox">
            {showDefault &&
              renderOption(null, 0, defaultLabel, "Follows the server's default if it changes")}
            {sections.map((section, sectionIndex) => {
              const headingId = `${id}-section-${sectionIndex}`;
              return (
                <div key={section.label} role="group" aria-labelledby={headingId}>
                  <div
                    id={headingId}
                    role="presentation"
                    className="ui-text-xs text-muted bg-surface-subtle px-3 py-1.5 font-medium"
                  >
                    {section.label}
                  </div>
                  {section.models.map((model, modelIndex) =>
                    renderOption(
                      model,
                      sectionOffsets[sectionIndex] + modelIndex,
                      model.displayName,
                      formatModelDetails(model)
                    )
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

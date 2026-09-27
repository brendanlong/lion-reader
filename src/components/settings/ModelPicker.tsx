/**
 * Searchable model picker (ARIA combobox) for AI settings. Provider catalogs
 * like OpenRouter's list hundreds of models, so suggested models lead and
 * search covers the rest.
 */

"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { CheckIcon, ChevronDownIcon } from "@/components/ui/icons";
import {
  buildModelPickerSections,
  formatModelDetails,
  type PickerModel,
} from "@/lib/ai/model-picker";

interface ModelPickerProps {
  id: string;
  /** The selected `provider:model` ref (the default when the user hasn't picked one). */
  value: string;
  defaultModelId: string;
  models: PickerModel[];
  suggestedModelIds: string[];
  isLoading: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
}

export function ModelPicker({
  id,
  value,
  defaultModelId,
  models,
  suggestedModelIds,
  isLoading,
  disabled,
  onChange,
}: ModelPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const sections = useMemo(
    () => buildModelPickerSections(models, { query, suggestedModelIds, defaultModelId }),
    [models, query, suggestedModelIds, defaultModelId]
  );
  const options = useMemo(() => sections.flatMap((section) => section.models), [sections]);

  const listboxId = `${id}-listbox`;
  const optionId = (index: number) => `${id}-option-${index}`;
  const selected = models.find((model) => model.id === value);
  const selectedLabel = isLoading ? "Loading models..." : (selected?.displayName ?? value);

  useEffect(() => {
    if (isOpen) {
      document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [isOpen, activeIndex, id]);

  const open = () => {
    setQuery("");
    setActiveIndex(0);
    setIsOpen(true);
  };

  const select = (model: PickerModel) => {
    setIsOpen(false);
    if (model.id !== value) {
      onChange(model.id);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!isOpen) open();
        else setActiveIndex((index) => Math.min(index + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
        break;
      case "Enter":
        if (isOpen && options[activeIndex]) {
          event.preventDefault();
          select(options[activeIndex]);
        }
        break;
      case "Escape":
        if (isOpen) {
          event.preventDefault();
          setIsOpen(false);
        }
        break;
    }
  };

  let optionIndex = -1;

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={isOpen && options.length > 0 ? optionId(activeIndex) : undefined}
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
          setActiveIndex(0);
          setIsOpen(true);
        }}
        onKeyDown={handleKeyDown}
        disabled={disabled || isLoading}
        className="ui-text-sm bg-surface text-body placeholder:text-faint border-edge-input block w-full rounded-md border py-2 pr-9 pl-3 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <ChevronDownIcon className="text-faint pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2" />
      {isOpen && (
        <ul
          id={listboxId}
          role="listbox"
          className="bg-surface border-edge-input absolute z-20 mt-1 max-h-80 w-full overflow-y-auto rounded-md border shadow-lg"
        >
          {options.length === 0 ? (
            <li className="ui-text-sm text-muted px-3 py-2">No matching models</li>
          ) : (
            sections.map((section) => (
              <li key={section.label} role="presentation">
                <div className="ui-text-xs text-muted bg-surface-subtle px-3 py-1.5 font-medium">
                  {section.label}
                </div>
                <ul role="group" aria-label={section.label}>
                  {section.models.map((model) => {
                    optionIndex += 1;
                    const index = optionIndex;
                    const isSelected = model.id === value;
                    return (
                      <li
                        key={model.id}
                        id={optionId(index)}
                        role="option"
                        aria-selected={isSelected}
                        // Keep focus in the input so blur doesn't close the list before the click lands.
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => select(model)}
                        onMouseMove={() => setActiveIndex(index)}
                        className={`flex cursor-pointer items-start gap-2 px-3 py-2 ${
                          index === activeIndex
                            ? "control-outline bg-surface-muted"
                            : "control-outline-none"
                        }`}
                      >
                        <span className="mt-0.5 w-4 flex-shrink-0">
                          {isSelected && <CheckIcon className="text-body h-4 w-4" />}
                        </span>
                        <span className="min-w-0">
                          <span className="ui-text-sm text-body block">
                            {model.displayName}
                            {model.id === defaultModelId ? " (default)" : ""}
                          </span>
                          <span className="ui-text-xs text-muted block break-words">
                            {formatModelDetails(model)}
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

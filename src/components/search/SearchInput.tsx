/**
 * SearchInput Component
 *
 * Search input for the /search page. Debounces input and updates the URL
 * query parameter `q` to drive full-text search via entries.list.
 *
 * Autofocuses on mount. Keyboard shortcuts are disabled while focused.
 */

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { clientReplace } from "@/lib/navigation";
import { SearchIcon, CloseIcon } from "@/components/ui/icon-button";
import { useKeyboardShortcutsContext } from "@/components/keyboard/KeyboardShortcutsProvider";

const DEBOUNCE_MS = 300;

export function SearchInput() {
  const searchParams = useSearchParams();
  const urlQuery = searchParams?.get("q") ?? "";
  const [inputValue, setInputValue] = useState(urlQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const { setEnabled: setKeyboardShortcutsEnabled } = useKeyboardShortcutsContext();

  // Track the last value we wrote to the URL to distinguish external changes
  // (e.g., browser back/forward) from our own debounced updates
  const lastWrittenRef = useRef(urlQuery);

  // Sync input value when URL changes externally (browser back/forward).
  // We detect external changes by comparing the URL value with what we last wrote.
  if (urlQuery !== lastWrittenRef.current) {
    lastWrittenRef.current = urlQuery;
    if (urlQuery !== inputValue) {
      setInputValue(urlQuery);
    }
  }

  // Debounce URL updates
  useEffect(() => {
    const timer = setTimeout(() => {
      if (inputValue !== urlQuery) {
        const params = new URLSearchParams(searchParams?.toString() ?? "");
        if (inputValue) {
          params.set("q", inputValue);
        } else {
          params.delete("q");
        }
        const queryString = params.toString();
        const url = queryString ? `/search?${queryString}` : "/search";
        lastWrittenRef.current = inputValue;
        clientReplace(url);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [inputValue, urlQuery, searchParams]);

  // Autofocus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Disable keyboard shortcuts while input is focused
  const handleFocus = useCallback(() => {
    setKeyboardShortcutsEnabled(false);
  }, [setKeyboardShortcutsEnabled]);

  const handleBlur = useCallback(() => {
    setKeyboardShortcutsEnabled(true);
  }, [setKeyboardShortcutsEnabled]);

  const handleClear = useCallback(() => {
    setInputValue("");
    inputRef.current?.focus();
  }, []);

  return (
    <div className="relative flex-1">
      <SearchIcon className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-400 dark:text-zinc-500" />
      <input
        ref={inputRef}
        type="search"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder="Search entries..."
        aria-label="Search entries"
        className="ui-text-sm w-full rounded-lg border border-zinc-200 bg-white py-2 pr-8 pl-9 text-zinc-900 placeholder-zinc-400 transition-colors outline-none focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder-zinc-500 dark:focus:border-zinc-500 dark:focus:ring-zinc-500"
      />
      {inputValue && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
          aria-label="Clear search"
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

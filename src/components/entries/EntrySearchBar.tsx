/**
 * EntrySearchBar Component
 *
 * Full-text search input for entry list pages. The bar is hidden behind the
 * header search toggle (see EntryPageLayout) so it stays out of the way until
 * asked for. The draft text is local state; a search is committed (written to
 * the `?q=` URL param, which drives the entries.list query) only on submit.
 */

"use client";

import { useState, type KeyboardEvent, type RefObject } from "react";
import { CloseIcon, SearchIcon } from "@/components/ui/icon-button";

interface EntrySearchBarProps {
  /** The committed search query from the URL (undefined when not searching). */
  query: string | undefined;

  /** Commit a search (empty/null clears the active search). */
  onSearch: (query: string | null) => void;

  /** Close the bar, clearing any active search. */
  onClose: () => void;

  /**
   * Ref to the input element so the parent can focus it (search toggle
   * button, `/` keyboard shortcut).
   */
  inputRef: RefObject<HTMLInputElement | null>;

  /** Focus the input when the bar mounts (user-initiated open, not deep link). */
  autoFocus?: boolean;
}

export function EntrySearchBar({
  query,
  onSearch,
  onClose,
  inputRef,
  autoFocus = false,
}: EntrySearchBarProps) {
  // Draft text being typed; committed to the URL only on submit.
  const [text, setText] = useState(query ?? "");

  // Reset the draft when the committed query changes underneath us
  // (back/forward navigation, external URL change) — render-time state
  // adjustment, not an effect (react-hooks/set-state-in-effect).
  const [prevQuery, setPrevQuery] = useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    setText(query ?? "");
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSearch(text);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="relative mb-4 sm:mb-6" role="search">
      <SearchIcon className="text-faint pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
      <input
        ref={inputRef}
        type="search"
        enterKeyHint="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search entries… (press Enter)"
        aria-label="Search entries"
        autoFocus={autoFocus}
        className="ui-text-sm bg-surface text-body placeholder:text-faint border-edge-input block w-full rounded-md border py-2 pr-10 pl-9 [&::-webkit-search-cancel-button]:hidden"
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close search"
        title="Close search"
        className="text-muted hover:text-body absolute top-1/2 right-1 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-md transition-colors"
      >
        <CloseIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

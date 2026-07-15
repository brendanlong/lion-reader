/**
 * EntryPageLayout Component
 *
 * Shared layout component for entry list pages (All, Starred, Saved, Subscription, Tag, Uncategorized).
 * Handles the header with title and actions. Entry content and list are passed as slots.
 *
 * The buttons use non-suspending hooks directly, so they render immediately
 * while the entry list can suspend independently.
 */

"use client";

import { useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { useHotkeys } from "react-hotkeys-hook";
import { type MarkAllReadOptions, useEntryMutations } from "@/lib/hooks/useEntryMutations";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";
import { useEntryUrlState } from "@/lib/hooks/useEntryUrlState";
import { useKeyboardShortcutsContext } from "@/components/keyboard/KeyboardShortcutsProvider";
import { SearchIcon } from "@/components/ui/icon-button";
import { StateToggleButton } from "@/components/ui/state-toggle-button";
import { UnreadToggle } from "./UnreadToggle";
import { SortToggle } from "./SortToggle";
import { MarkAllReadButton } from "./MarkAllReadButton";
import { EntrySearchBar } from "./EntrySearchBar";

/**
 * Loading skeleton for the page title.
 */
export function TitleSkeleton() {
  return <div className="bg-fill-muted h-8 w-48 animate-pulse rounded" />;
}

/**
 * Title text component - renders the h1 with proper styling.
 */
export function TitleText({ children }: { children: ReactNode }) {
  return <h1 className="ui-text-xl sm:ui-text-2xl text-body font-bold">{children}</h1>;
}

interface EntryPageLayoutProps {
  /** Title slot - typically a Suspense-wrapped title component */
  titleSlot: ReactNode;

  /** Entry content slot - full screen view when an entry is open */
  entryContentSlot: ReactNode;

  /** Entry list slot - renders its own inline loading fallback (no Suspense) */
  entryListSlot: ReactNode;

  /** Context description for the mark all read dialog (e.g., "all feeds", "this subscription") */
  markAllReadDescription: string;

  /** Options to pass to handleMarkAllRead */
  markAllReadOptions: MarkAllReadOptions;

  /** Whether to hide the sort toggle (e.g., for algorithmic feed) */
  hideSortToggle?: boolean;
}

export function EntryPageLayout({
  titleSlot,
  entryContentSlot,
  entryListSlot,
  markAllReadDescription,
  markAllReadOptions,
  hideSortToggle = false,
}: EntryPageLayoutProps) {
  // Use non-suspending hooks directly so buttons render immediately
  const {
    showUnreadOnly,
    toggleShowUnreadOnly,
    sortOrder,
    toggleSortOrder,
    searchQuery,
    setSearchQuery,
  } = useUrlViewPreferences();
  const { markAllRead, isMarkAllReadPending } = useEntryMutations();
  const { openEntryId } = useEntryUrlState();
  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const pathname = usePathname();

  // The search bar stays out of the way until asked for: it renders only while
  // explicitly opened (toggle button / `/` shortcut) or a search is active in
  // the URL (?q=, e.g. a deep link).
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isSearching = searchQuery !== undefined;
  const showSearchBar = searchOpen || isSearching;

  // Navigating to a different view closes an empty search bar (an active
  // search lives in the URL, so it never survives navigation anyway) —
  // render-time state adjustment, not an effect.
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    setSearchOpen(false);
  }

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery(null);
  };

  const handleSearchToggle = () => {
    if (showSearchBar) {
      closeSearch();
    } else {
      setSearchOpen(true);
    }
  };

  // `/` focuses the search input (opening the bar if needed), matching the
  // convention of other readers. enableOnFormTags stays false so typing "/"
  // inside the input itself is unaffected.
  useHotkeys(
    "/",
    (e) => {
      e.preventDefault();
      if (searchInputRef.current) {
        searchInputRef.current.focus();
      } else {
        setSearchOpen(true);
      }
    },
    // useKey matches the produced character (event.key) rather than the
    // physical key code — "/" has no layout-independent code.
    { enabled: keyboardShortcutsEnabled && !openEntryId, enableOnFormTags: false, useKey: true },
    [keyboardShortcutsEnabled, openEntryId]
  );

  return (
    <>
      {/* Entry content - full screen when viewing an entry */}
      {entryContentSlot}

      {/* Main content area - hidden when viewing an entry */}
      <div className={`mx-auto max-w-3xl px-4 py-4 sm:p-6 ${openEntryId ? "hidden" : ""}`}>
        {/* Header with title and buttons */}
        <div className="mb-4 flex items-center justify-between sm:mb-6">
          {titleSlot}
          <div className="flex gap-2">
            {/* While searching, hide the controls that don't apply to search
                results: mark-all-read acts on the whole view (not just the
                matches), and search results are relevance-ranked (sort order
                is ignored by the backend). */}
            {!isSearching && (
              <MarkAllReadButton
                contextDescription={markAllReadDescription}
                isLoading={isMarkAllReadPending}
                onConfirm={() => markAllRead(markAllReadOptions)}
              />
            )}
            {!hideSortToggle && !isSearching && (
              <SortToggle sortOrder={sortOrder} onToggle={toggleSortOrder} />
            )}
            <UnreadToggle showUnreadOnly={showUnreadOnly} onToggle={toggleShowUnreadOnly} />
            <StateToggleButton
              icon={<SearchIcon className="h-5 w-5" />}
              label="Search"
              ariaLabel={showSearchBar ? "Close search bar" : "Search entries"}
              isPressed={showSearchBar}
              onToggle={handleSearchToggle}
            />
          </div>
        </div>

        {/* Search bar - hidden until opened or a search is active */}
        {showSearchBar && (
          <EntrySearchBar
            query={searchQuery}
            onSearch={setSearchQuery}
            onClose={closeSearch}
            inputRef={searchInputRef}
            autoFocus={searchOpen}
          />
        )}

        {/* Entry list */}
        {entryListSlot}
      </div>
    </>
  );
}

/**
 * EntryPageLayout Component
 *
 * Shared layout component for entry list pages (All, Starred, Saved, Subscription, Tag,
 * Uncategorized, Recently Read).
 * Handles the header with title and actions. Entry content and list are passed as slots.
 *
 * The buttons use non-suspending hooks directly, so they render immediately
 * while the entry list can suspend independently.
 */

"use client";

import { useRef, useState, type ReactNode } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { type MarkAllReadOptions, useEntryMutations } from "@/lib/hooks/useEntryMutations";
import { useUrlViewPreferences } from "@/lib/hooks/useUrlViewPreferences";
import { useEntryUrlState } from "@/lib/hooks/useEntryUrlState";
import { useAppPathname } from "@/lib/hooks/useAppLocation";
import { useKeyboardShortcutsContext } from "@/components/keyboard/KeyboardShortcutsProvider";
import { SHORTCUTS } from "@/components/keyboard/shortcuts";
import { SearchIcon } from "@/components/ui/icons";
import { SkeletonText } from "@/components/ui/skeleton";
import { StateToggleButton } from "@/components/ui/state-toggle-button";
import { UnreadToggle } from "./UnreadToggle";
import { SortToggle, shownSortOrder } from "./SortToggle";
import { useEntriesListInput } from "@/lib/hooks/useEntriesListInput";
import { useListSortable } from "@/lib/hooks/useLocalEntries";
import { useCanRenderFromCache } from "@/lib/hooks/useIsHydrated";
import { MarkAllReadButton } from "./MarkAllReadButton";
import { EntrySearchBar } from "./EntrySearchBar";

const TITLE_CLASSES = "text-body font-bold";

export function TitleSkeleton() {
  return <SkeletonText width="w-32" className={`${TITLE_CLASSES} inline-flex`} />;
}

/**
 * Title text component - renders the h1 with proper styling.
 */
export function TitleText({ children }: { children: ReactNode }) {
  return <h1 className={`${TITLE_CLASSES} inline wrap-break-word`}>{children}</h1>;
}

interface EntryPageLayoutProps {
  /** Title slot - typically a Suspense-wrapped title component */
  titleSlot: ReactNode;

  /** Entry content slot - full screen view when an entry is open */
  entryContentSlot: ReactNode;

  /** Entry list slot - renders its own inline loading fallback (no Suspense) */
  entryListSlot: ReactNode;

  /**
   * Context description for the mark all read dialog (e.g., "all feeds", "this
   * subscription"); null hides the button and its shortcut.
   */
  markAllReadDescription: string | null;

  /** Options to pass to handleMarkAllRead */
  markAllReadOptions: MarkAllReadOptions;
}

export function EntryPageLayout({
  titleSlot,
  entryContentSlot,
  entryListSlot,
  markAllReadDescription,
  markAllReadOptions,
}: EntryPageLayoutProps) {
  // Use non-suspending hooks directly so buttons render immediately
  const { showUnreadOnly, toggleShowUnreadOnly, setSortOrder, searchQuery, setSearchQuery } =
    useUrlViewPreferences();
  const { markAllRead, isMarkAllReadPending } = useEntryMutations();
  // The sort chosen in the URL, if the list can use it (`buildEntriesListInput`),
  // shown by Date while its values are gone (the choice stays for when they
  // return); without one, the sort the server listed it in (#2064).
  // Read from the store only once it can render from it, or the server's and
  // the hydrating client's first renders disagree.
  const listInput = useEntriesListInput();
  const storedSortable = useListSortable(listInput);
  const sortable = useCanRenderFromCache() ? storedSortable : undefined;
  const { openEntryId } = useEntryUrlState();
  const { enabled: keyboardShortcutsEnabled } = useKeyboardShortcutsContext();
  const pathname = useAppPathname();

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
    SHORTCUTS.search.hotkey,
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
    {
      enabled: keyboardShortcutsEnabled && !openEntryId,
      enableOnFormTags: false,
      useKey: true,
    },
    [keyboardShortcutsEnabled, openEntryId]
  );

  return (
    <>
      {/* Entry content - full screen when viewing an entry */}
      {entryContentSlot}

      {/* Main content area - hidden when viewing an entry */}
      <div className={`mx-auto max-w-3xl px-4 py-4 sm:p-6 ${openEntryId ? "hidden" : ""}`}>
        {/* The toolbar floats after the title, so it lands on the header's last
            line (beside the title or site link if they leave room, else below
            them) and stays right above the list; the title slot's pieces must
            be inline for that. The title inherits its font size from here so
            every line is exactly leading-11, the toolbar's min-h-11.
            sm:leading-11 isn't redundant: sm:ui-text-2xl would override it. */}
        <div className="ui-text-xl sm:ui-text-2xl mb-4 flow-root leading-11 sm:mb-6 sm:leading-11">
          {titleSlot}
          <div className="float-right ml-4 flex min-h-11 items-center gap-2">
            <StateToggleButton
              icon={<SearchIcon className="h-5 w-5" />}
              label={showSearchBar ? "Close search" : "Search"}
              ariaLabel={showSearchBar ? "Close search bar" : "Search entries"}
              isPressed={showSearchBar}
              onToggle={handleSearchToggle}
            />
            {/* While searching, hide the controls that don't apply to search
                results: mark-all-read acts on the whole view (not just the
                matches), and search results are relevance-ranked (sort order
                is ignored by the backend). */}
            {!isSearching && markAllReadDescription !== null && (
              <MarkAllReadButton
                contextDescription={markAllReadDescription}
                isLoading={isMarkAllReadPending}
                onConfirm={() => markAllRead(markAllReadOptions)}
                shortcutEnabled={keyboardShortcutsEnabled && !openEntryId}
              />
            )}
            {!isSearching && (
              <SortToggle
                sortOrder={
                  listInput.sortOrder
                    ? shownSortOrder(listInput.sortOrder, sortable)
                    : (sortable?.sort?.sortOrder ?? "newest")
                }
                sortable={sortable}
                onChange={setSortOrder}
              />
            )}
            <UnreadToggle showUnreadOnly={showUnreadOnly} onToggle={toggleShowUnreadOnly} />
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

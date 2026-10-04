/**
 * CollectionsButton
 *
 * Reader action-bar button that opens a picker for adding the entry to (or
 * removing it from) the user's collections. One search box filters the
 * collections and, when the text matches none exactly, offers to create one
 * with that name. Toggles save immediately, so there's no confirm step.
 */

"use client";

import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { useCollectionMembership } from "@/lib/hooks/useCollectionMembership";
import { useDebouncedValue } from "@/lib/hooks/useDebouncedValue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { BookmarkIcon, CheckIcon, CloseIcon, PlusIcon, SearchIcon } from "@/components/ui/icons";
import { COLLECTION_NAME_MAX_LENGTH, untitledSubscriptionLabel } from "@/lib/collections";

const SEARCH_DEBOUNCE_MS = 200;
const PAGE_SIZE = 100;

export function CollectionsButton({ entryId }: { entryId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const membership = useCollectionMembership(entryId);
  const count = membership.collectionIds?.length ?? 0;
  const close = () => setIsOpen(false);

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setIsOpen(true)}>
        <BookmarkIcon className="h-4 w-4" />
        <span className="ml-2">{count > 0 ? `Collections (${count})` : "Add to Collection"}</span>
      </Button>
      <Dialog
        isOpen={isOpen}
        onClose={close}
        title="Collections"
        titleId="collections-picker-title"
        size="sm"
      >
        {isOpen && <CollectionsPicker membership={membership} onClose={close} />}
      </Dialog>
    </>
  );
}

type PickerOption =
  | { kind: "collection"; id: string; title: string; isMember: boolean }
  | { kind: "create"; name: string };

const optionKey = (option: PickerOption) => (option.kind === "collection" ? option.id : "create");

function CollectionsPicker({
  membership,
  onClose,
}: {
  membership: ReturnType<typeof useCollectionMembership>;
  onClose: () => void;
}) {
  const listId = useId();
  const utils = trpc.useUtils();
  const [query, setQuery] = useState("");
  // The row the user moved to with the arrow keys or the pointer, by key so
  // it stays on the same collection when rows move; null for the default.
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  // Listed first: the article's collections as of opening, not live, so a
  // toggle doesn't move the row under the pointer.
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string> | null>(null);
  if (pinnedIds === null && membership.collectionIds) {
    setPinnedIds(new Set(membership.collectionIds));
  }
  const [createdHere, setCreatedHere] = useState<{ id: string; title: string }[]>([]);
  const name = query.trim();
  const search = useDebouncedValue(name, SEARCH_DEBOUNCE_MS);

  const collectionsQuery = trpc.subscriptions.list.useInfiniteQuery(
    { type: "collection", query: search || undefined, limit: PAGE_SIZE },
    { getNextPageParam: (lastPage) => lastPage.nextCursor, placeholderData: keepPreviousData }
  );
  // Until the results are for what's typed, "no exact match" may be wrong,
  // so neither offer nor default to creating it.
  const settled = name === search && !collectionsQuery.isPlaceholderData;

  const memberIds = new Set(membership.collectionIds);
  const fetched = collectionsQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const fetchedIds = new Set(fetched.map((collection) => collection.id));
  const isPinned = (id: string) => Boolean(pinnedIds?.has(id));
  const collections = [
    // Kept in view even if it sorts past the first page.
    ...(search ? [] : createdHere.filter((c) => !fetchedIds.has(c.id))),
    ...fetched.map((c) => ({ id: c.id, title: c.title || untitledSubscriptionLabel(c.type) })),
  ]
    .map((c) => ({ kind: "collection" as const, ...c, isMember: memberIds.has(c.id) }))
    .sort((a, b) => Number(isPinned(b.id)) - Number(isPinned(a.id)));

  const exactIndex = name
    ? collections.findIndex((c) => c.title.toLowerCase() === name.toLowerCase())
    : -1;
  const options: PickerOption[] =
    name && settled && exactIndex === -1 ? [...collections, { kind: "create", name }] : collections;
  const chosenIndex =
    chosenKey === null ? -1 : options.findIndex((o) => optionKey(o) === chosenKey);
  // With text typed, Enter goes to an exact match, else to "Create".
  const defaultIndex = exactIndex !== -1 ? exactIndex : name && settled ? options.length - 1 : -1;
  const highlighted = chosenIndex !== -1 ? chosenIndex : defaultIndex;
  const highlightedOption = options[highlighted];

  const optionId = (option: PickerOption) => `${listId}-${optionKey(option)}`;
  const highlightedId = highlightedOption && optionId(highlightedOption);
  useEffect(() => {
    if (highlightedId) {
      document.getElementById(highlightedId)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [highlightedId]);

  const activate = async (option: PickerOption | undefined) => {
    if (!option || membership.isUpdating) return;
    if (option.kind === "collection") {
      membership.setMember(option.id, !option.isMember);
      return;
    }
    const collection = await membership.createWithEntry(option.name);
    if (collection) {
      setCreatedHere((prev) => [
        { id: collection.id, title: collection.title || option.name },
        ...prev,
      ]);
      setQuery("");
      setChosenKey(collection.id);
    }
  };

  // Enter typed ahead of the search results: look the name up first, so an
  // existing collection is toggled rather than duplicated.
  const activateTypedName = async () => {
    const { items } = await utils.subscriptions.list.fetch({
      type: "collection",
      query: name,
      limit: PAGE_SIZE,
    });
    const match = items.find(
      (c) => (c.title || untitledSubscriptionLabel(c.type)).toLowerCase() === name.toLowerCase()
    );
    await activate(
      match
        ? { kind: "collection", id: match.id, title: name, isMember: memberIds.has(match.id) }
        : { kind: "create", name }
    );
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (options.length === 0) return;
      const down = e.key === "ArrowDown";
      const next =
        highlighted === -1
          ? down
            ? 0
            : options.length - 1
          : (highlighted + (down ? 1 : -1) + options.length) % options.length;
      setChosenKey(optionKey(options[next]));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (settled || chosenIndex !== -1 || exactIndex !== -1) void activate(highlightedOption);
      else if (name) void activateTypedName();
    }
  };

  const loading = collectionsQuery.isLoading || membership.membershipStatus === "pending";
  const failed = collectionsQuery.isError || membership.membershipStatus === "error";
  const showList = !loading && !failed && options.length > 0;

  return (
    <>
      <DialogHeader className="flex items-center justify-between">
        <DialogTitle id="collections-picker-title">Collections</DialogTitle>
        <IconButton icon={<CloseIcon className="h-5 w-5" />} aria-label="Close" onClick={onClose} />
      </DialogHeader>
      <DialogBody>
        <div className="relative">
          <SearchIcon className="text-faint pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            type="text"
            role="combobox"
            aria-label="Search or create a collection"
            aria-expanded={showList}
            aria-controls={showList ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={showList ? highlightedId : undefined}
            placeholder="Search or create a collection"
            value={query}
            maxLength={COLLECTION_NAME_MAX_LENGTH}
            onChange={(e) => {
              setQuery(e.target.value);
              setChosenKey(null);
            }}
            onKeyDown={handleKeyDown}
            className="min-h-[44px] pl-9"
          />
        </div>

        {failed ? (
          <p className="ui-text-sm text-danger mt-3">Couldn&apos;t load your collections.</p>
        ) : loading ? (
          <div className="mt-3 space-y-1" aria-hidden="true">
            {[1, 2].map((i) => (
              <div key={i} className="bg-fill-muted h-11 animate-pulse rounded-md" />
            ))}
          </div>
        ) : !showList ? (
          name ? null : (
            <p className="ui-text-sm text-muted mt-3">
              Type a name to create your first collection.
            </p>
          )
        ) : (
          <ul
            id={listId}
            role="listbox"
            aria-label="Collections"
            aria-multiselectable="true"
            className="mt-3 max-h-72 space-y-1 overflow-y-auto"
          >
            {options.map((option, index) => (
              <li
                key={optionKey(option)}
                id={optionId(option)}
                role="option"
                aria-selected={option.kind === "collection" && option.isMember}
                aria-disabled={membership.isUpdating}
                // Keep focus in the search box while clicking a row.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setChosenKey(optionKey(option))}
                onClick={() => void activate(option)}
                className={`ui-text-sm text-body flex min-h-[44px] cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-colors ${
                  index === highlighted
                    ? "bg-surface-muted control-outline"
                    : "control-outline-none"
                }`}
              >
                {option.kind === "collection" ? (
                  <>
                    <span
                      aria-hidden="true"
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        option.isMember
                          ? "border-primary-solid bg-primary-solid text-primary-solid-foreground"
                          : "border-edge-input"
                      }`}
                    >
                      {option.isMember && <CheckIcon className="h-3 w-3" />}
                    </span>
                    <span className="truncate">{option.title}</span>
                  </>
                ) : (
                  <>
                    <PlusIcon className="text-muted h-4 w-4 shrink-0" />
                    <span className="truncate">
                      {membership.isCreating ? "Creating" : "Create"} &ldquo;{option.name}&rdquo;
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {collectionsQuery.hasNextPage && !failed && (
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => void collectionsQuery.fetchNextPage()}
            loading={collectionsQuery.isFetchingNextPage}
          >
            Show more
          </Button>
        )}
      </DialogBody>
    </>
  );
}

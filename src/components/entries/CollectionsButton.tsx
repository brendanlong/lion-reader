/**
 * CollectionsButton
 *
 * Reader action-bar button that opens a picker for adding the entry to (or
 * removing it from) the user's collections. One search box filters the
 * collections and, when the text matches none exactly, offers to create one
 * with that name. Toggles save immediately, so there's no confirm step.
 */

"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { useCollectionMembership } from "@/lib/hooks/useCollectionMembership";
import { useDebouncedValue } from "@/lib/hooks/useDebouncedValue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogTitle } from "@/components/ui/dialog";
import { BookmarkIcon, CheckIcon, PlusIcon, SearchIcon } from "@/components/ui/icons";
import { COLLECTION_NAME_MAX_LENGTH, untitledSubscriptionLabel } from "@/lib/collections";

const SEARCH_DEBOUNCE_MS = 200;
const PAGE_SIZE = 50;

export function CollectionsButton({ entryId }: { entryId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const membership = useCollectionMembership(entryId);
  const count = membership.collectionIds?.length ?? 0;

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setIsOpen(true)}>
        <BookmarkIcon className="h-4 w-4" />
        <span className="ml-2">{count > 0 ? `Collections (${count})` : "Add to Collection"}</span>
      </Button>
      <Dialog
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Collections"
        titleId="collections-picker-title"
        size="sm"
      >
        {isOpen && <CollectionsPicker membership={membership} />}
      </Dialog>
    </>
  );
}

type PickerOption =
  | { kind: "collection"; id: string; title: string; isMember: boolean }
  | { kind: "create"; name: string };

function CollectionsPicker({
  membership,
}: {
  membership: ReturnType<typeof useCollectionMembership>;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  // null: the default highlight (see `highlighted`); a number once the user
  // moves it with the arrow keys or the pointer.
  const [chosenIndex, setChosenIndex] = useState<number | null>(null);
  const name = query.trim();
  const search = useDebouncedValue(name, SEARCH_DEBOUNCE_MS);

  const collectionsQuery = trpc.subscriptions.list.useInfiniteQuery(
    { type: "collection", query: search || undefined, limit: PAGE_SIZE },
    { getNextPageParam: (lastPage) => lastPage.nextCursor, placeholderData: keepPreviousData }
  );
  const memberIds = new Set(membership.collectionIds);
  const collections = (collectionsQuery.data?.pages.flatMap((page) => page.items) ?? [])
    .map((collection) => ({
      kind: "collection" as const,
      id: collection.id,
      title: collection.title || untitledSubscriptionLabel(collection.type),
      isMember: memberIds.has(collection.id),
    }))
    // Where the article already is first: usually what you're looking for.
    .sort((a, b) => Number(b.isMember) - Number(a.isMember));

  const exactIndex = name
    ? collections.findIndex((c) => c.title.toLowerCase() === name.toLowerCase())
    : -1;
  const options: PickerOption[] =
    name && exactIndex === -1 ? [...collections, { kind: "create", name }] : collections;
  // With text typed, Enter goes to an exact match, else to "Create".
  const defaultIndex = !name ? -1 : exactIndex !== -1 ? exactIndex : options.length - 1;
  const highlighted = Math.min(chosenIndex ?? defaultIndex, options.length - 1);

  const activate = async (option: PickerOption | undefined) => {
    if (!option || membership.isUpdating) return;
    if (option.kind === "collection") {
      membership.setMember(option.id, !option.isMember);
      return;
    }
    if (await membership.createWithEntry(option.name)) {
      setQuery("");
      setChosenIndex(null);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (options.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setChosenIndex((highlighted + step + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      void activate(options[highlighted]);
    }
  };

  const optionId = (index: number) => `${listId}-option-${index}`;
  const loading = collectionsQuery.isLoading || membership.membershipStatus === "pending";
  const failed = collectionsQuery.isError || membership.membershipStatus === "error";

  return (
    <>
      <DialogTitle id="collections-picker-title">Collections</DialogTitle>
      <DialogBody>
        <div className="relative">
          <SearchIcon className="text-faint pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <input
            type="text"
            role="combobox"
            aria-label="Search or create a collection"
            aria-expanded={options.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={highlighted >= 0 ? optionId(highlighted) : undefined}
            placeholder="Search or create a collection"
            value={query}
            maxLength={COLLECTION_NAME_MAX_LENGTH}
            onChange={(e) => {
              setQuery(e.target.value);
              setChosenIndex(null);
            }}
            onKeyDown={handleKeyDown}
            className="ui-text-sm bg-surface text-body placeholder:text-faint border-edge-input block min-h-[44px] w-full rounded-md border py-2 pr-3 pl-9"
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
        ) : options.length === 0 ? (
          <p className="ui-text-sm text-muted mt-3">Type a name to create your first collection.</p>
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
                key={option.kind === "collection" ? option.id : "create"}
                id={optionId(index)}
                role="option"
                aria-selected={option.kind === "collection" && option.isMember}
                aria-disabled={membership.isUpdating}
                // Keep focus in the search box while clicking a row.
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => setChosenIndex(index)}
                onClick={() => void activate(option)}
                className={`ui-text-sm text-body flex min-h-[44px] cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-colors ${
                  index === highlighted ? "bg-surface-muted" : ""
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
                    <span className="truncate">Create &ldquo;{option.name}&rdquo;</span>
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

/**
 * CollectionsButton
 *
 * Reader action-bar button that opens a picker for adding the entry to (or
 * removing it from) the user's collections, or creating a new one with it.
 */

"use client";

import { useState, type FormEvent } from "react";
import { trpc } from "@/lib/trpc/client";
import { useCollectionMembership } from "@/lib/hooks/useCollectionMembership";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { BookmarkIcon, CheckIcon } from "@/components/ui/icons";

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
        {isOpen && <CollectionsPicker membership={membership} onDone={() => setIsOpen(false)} />}
      </Dialog>
    </>
  );
}

function CollectionsPicker({
  membership,
  onDone,
}: {
  membership: ReturnType<typeof useCollectionMembership>;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const collectionsQuery = trpc.subscriptions.list.useQuery({ type: "collection", limit: 100 });
  const collections = collectionsQuery.data?.items ?? [];
  const memberIds = new Set(membership.collectionIds);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    await membership.createWithEntry(trimmed);
    setName("");
  };

  return (
    <>
      <DialogTitle id="collections-picker-title">Collections</DialogTitle>
      <DialogBody>
        {collectionsQuery.isLoading ? (
          <div className="bg-fill-muted h-11 animate-pulse rounded-md" />
        ) : collections.length === 0 ? (
          <p className="ui-text-sm text-muted">
            Collections group articles from any feed. Name one below to start.
          </p>
        ) : (
          <ul className="space-y-1">
            {collections.map((collection) => {
              const isMember = memberIds.has(collection.id);
              return (
                <li key={collection.id}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isMember}
                    onClick={() => membership.setMember(collection.id, !isMember)}
                    disabled={membership.isUpdating}
                    className={`ui-text-sm text-body flex min-h-[44px] w-full items-center justify-between rounded-md px-3 py-2 text-left transition-colors ${
                      isMember
                        ? "control-outline bg-surface-muted"
                        : "control-outline-none hover:bg-surface-muted"
                    }`}
                  >
                    <span className="truncate">{collection.title || "Untitled collection"}</span>
                    {isMember && <CheckIcon className="h-4 w-4 shrink-0" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <form onSubmit={handleCreate} className="mt-4 flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Input
              id="new-collection-name"
              label="New collection"
              placeholder="e.g. Research"
              value={name}
              maxLength={255}
              onChange={(e) => setName(e.target.value)}
              disabled={membership.isCreating}
            />
          </div>
          <Button type="submit" disabled={!name.trim()} loading={membership.isCreating}>
            Create
          </Button>
        </form>
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

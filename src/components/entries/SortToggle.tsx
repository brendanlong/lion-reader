/**
 * SortToggle Component
 *
 * The list's sort (#2064): a toggle between the two directions of the sort
 * in use (Newest/Oldest, Highest/Lowest, First/Last), and, when the list has
 * scores or positions, a picker between Date and those.
 */

"use client";

import { SortDescendingIcon, SortAscendingIcon } from "@/components/ui/icons";
import { StateToggleButton } from "@/components/ui/state-toggle-button";
import {
  ENTRY_SORT_DIRECTIONS,
  reverseSortOrder,
  sortFieldOf,
  type EntrySortOrder,
} from "@/lib/entry-sort";

const DIRECTION_LABELS: Record<EntrySortOrder, string> = {
  newest: "Newest",
  oldest: "Oldest",
  highest: "Highest",
  lowest: "Lowest",
  first: "First",
  last: "Last",
};

const FIELD_LABELS = { published: "Date", score: "Score", position: "Position" } as const;

type SortField = keyof typeof FIELD_LABELS;

interface SortToggleProps {
  /** The sort the list is shown in. */
  sortOrder: EntrySortOrder;

  /** Which ranked sorts the list has values for; undefined while unknown. */
  sortable?: { score: boolean; position: boolean };

  /**
   * Called with the sort to switch to. Optional so it can render inert during
   * SSR (see StateToggleButton).
   */
  onChange?: (sortOrder: EntrySortOrder) => void;

  className?: string;
}

/** The sort to show a list in: the chosen one, or Date while its sort has no values. */
export function shownSortOrder(
  sortOrder: EntrySortOrder,
  sortable: SortToggleProps["sortable"]
): EntrySortOrder {
  const field = sortFieldOf(sortOrder);
  return field === "published" || !sortable || sortable[field] ? sortOrder : "newest";
}

export function SortToggle({ sortOrder, sortable, onChange, className = "" }: SortToggleProps) {
  const field = sortFieldOf(sortOrder);
  const reversed = sortOrder === ENTRY_SORT_DIRECTIONS[field][1];
  const next = reverseSortOrder(sortOrder);
  // A lower number further down: newest/highest/last descend.
  const descending = (field === "position") === reversed;
  const Icon = descending ? SortDescendingIcon : SortAscendingIcon;
  const fields = (["published", "score", "position"] as const).filter(
    (option) => option === "published" || option === field || sortable?.[option]
  );

  return (
    <div className={`flex gap-2 ${className}`}>
      {fields.length > 1 && (
        <select
          aria-label="Sort by"
          value={field}
          disabled={!onChange}
          onChange={(e) => onChange?.(ENTRY_SORT_DIRECTIONS[e.target.value as SortField][0])}
          className="ui-text-sm bg-surface text-body border-edge-input min-h-11 rounded-md border px-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {fields.map((option) => (
            <option key={option} value={option}>
              {FIELD_LABELS[option]}
            </option>
          ))}
        </select>
      )}
      <StateToggleButton
        icon={<Icon className="h-5 w-5" />}
        label={DIRECTION_LABELS[sortOrder]}
        ariaLabel={`Sort ${DIRECTION_LABELS[next].toLowerCase()} first`}
        isPressed={reversed}
        onToggle={onChange && (() => onChange(next))}
      />
    </div>
  );
}

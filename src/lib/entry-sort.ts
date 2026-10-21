/**
 * The orders an entry list can be sorted by (#2064), each with its two
 * directions, default first. Directions are named for what the number
 * means, so `score` sorts highest first and `position` first (lowest) first.
 * Entries without a score or position sort after every entry with one, in
 * both directions, newest first.
 */
export const ENTRY_SORT_DIRECTIONS = {
  published: ["newest", "oldest"],
  readChanged: ["newest", "oldest"],
  score: ["highest", "lowest"],
  position: ["first", "last"],
} as const;

export type EntrySortBy = keyof typeof ENTRY_SORT_DIRECTIONS;

export const ENTRY_SORT_BYS = Object.keys(ENTRY_SORT_DIRECTIONS) as [EntrySortBy, ...EntrySortBy[]];

export type EntrySortOrder = (typeof ENTRY_SORT_DIRECTIONS)[EntrySortBy][number];

export const ENTRY_SORT_ORDERS = [...new Set(Object.values(ENTRY_SORT_DIRECTIONS).flat())] as [
  EntrySortOrder,
  ...EntrySortOrder[],
];

/** The sorts that order by a value an entry may lack. */
export type RankedSortBy = "score" | "position";

export function isRankedSort(sortBy: string | undefined): sortBy is RankedSortBy {
  return sortBy === "score" || sortBy === "position";
}

/** The sort a direction belongs to: each name is one sort's, so it says both. */
export function sortFieldOf(order: EntrySortOrder): "published" | RankedSortBy {
  if (order === "highest" || order === "lowest") return "score";
  if (order === "first" || order === "last") return "position";
  return "published";
}

export function reverseSortOrder(order: EntrySortOrder): EntrySortOrder {
  const [first, second] = ENTRY_SORT_DIRECTIONS[sortFieldOf(order)];
  return order === first ? second : first;
}

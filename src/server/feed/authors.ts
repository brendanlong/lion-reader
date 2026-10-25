/** Longer author lists collapse to "First Author et al.". */
export const MAX_LISTED_AUTHORS = 3;

/**
 * Format an author list into the single `author` string entries and saved
 * articles store. Only call this with a real list: a free-text byline can't be
 * split on commas ("Smith, J.").
 */
export function formatAuthors(authors: readonly string[]): string | null {
  const names = authors.map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length === 0) return null;
  if (names.length > MAX_LISTED_AUTHORS) return `${names[0]} et al.`;
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

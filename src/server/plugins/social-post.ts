/**
 * Shared helpers for plugins that save individual social-media posts
 * (Bluesky, LinkedIn, Threads).
 */

/** Longest title we synthesize from a post's first line before eliding. */
const MAX_TITLE_LENGTH = 100;

/**
 * Build a saved-article title for a post that has no real title of its own: the
 * first line of its text, elided to a reasonable length, falling back to
 * "Post by {author}". Every social plugin uses this so their saved articles
 * read the same in the list, which is the only place a title is required.
 */
export function socialPostTitle(text: string | null | undefined, author: string | null): string {
  const firstLine = (text ?? "").split("\n")[0].trim();
  if (firstLine) {
    // Slice by code point, not UTF-16 unit, so truncation never leaves a lone
    // surrogate half (e.g. cutting through an emoji).
    const codePoints = [...firstLine];
    return codePoints.length > MAX_TITLE_LENGTH
      ? `${codePoints.slice(0, MAX_TITLE_LENGTH - 1).join("")}…`
      : firstLine;
  }
  return author ? `Post by ${author}` : "Post";
}

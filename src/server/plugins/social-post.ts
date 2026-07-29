/**
 * Shared helpers for plugins that save individual social-media posts
 * (Bluesky, LinkedIn, Threads).
 */

/**
 * Longest title we synthesize from a post's first line before eliding.
 *
 * A post has no title, so this is a heading invented out of its opening words —
 * it only has to identify the post in a list, and a post whose first line is a
 * whole paragraph would otherwise fill the heading with body text.
 */
const MAX_TITLE_LENGTH = 60;

/**
 * Shortest an elided title may be after backing up to a word boundary. Below
 * this we cut mid-word instead, so a single very long opening word (a URL, a
 * German compound) can't collapse the title to a couple of characters.
 */
const MIN_ELIDED_TITLE_LENGTH = 40;

/**
 * Build a saved-article title for a post that has no real title of its own: the
 * first line of its text, elided to a reasonable length, falling back to
 * "Post by {author}". Every social plugin uses this so their saved articles
 * read the same in the list, which is the only place a title is required.
 */
export function socialPostTitle(text: string | null | undefined, author: string | null): string {
  const firstLine = (text ?? "").split("\n")[0].trim();
  if (!firstLine) {
    return author ? `Post by ${author}` : "Post";
  }

  // Slice by code point, not UTF-16 unit, so truncation never leaves a lone
  // surrogate half (e.g. cutting through an emoji).
  const codePoints = [...firstLine];
  if (codePoints.length <= MAX_TITLE_LENGTH) {
    return firstLine;
  }

  let body = codePoints.slice(0, MAX_TITLE_LENGTH - 1).join("");

  // Drop a trailing partial word so the title doesn't end mid-word. Only when
  // the cut actually lands inside one: if either side of it is whitespace the
  // text already ends on a complete word, and backing up would throw away a
  // whole word for nothing.
  const cutsInsideAWord = !/\s$/.test(body) && !/\s/.test(codePoints[MAX_TITLE_LENGTH - 1] ?? "");
  if (cutsInsideAWord) {
    const atBoundary = body.replace(/\s+\S*$/, "");
    if ([...atBoundary].length >= MIN_ELIDED_TITLE_LENGTH) {
      body = atBoundary;
    }
  }

  // trimEnd so the ellipsis never follows a space ("Bob …").
  return `${body.trimEnd()}…`;
}

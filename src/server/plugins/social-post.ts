/**
 * Shared helpers for plugins that save individual social-media posts
 * (Bluesky, LinkedIn, Threads).
 */

import { escapeHtml } from "@/server/http/html";

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
 * Build a saved-article title from a post's opening words, falling back to
 * "Post by {author}". Every social plugin uses this so their saved articles read
 * the same in the list, which is the only place a title is required — including
 * LinkedIn, which passes its own `headline` through rather than a first line, so
 * a headline past the cap elides here too.
 */
export function socialPostTitle(text: string | null | undefined, author: string | null): string {
  // Collapse whitespace runs to single spaces. A title is a one-line heading, so
  // a post that pads with long space runs or hard-wraps its opening line would
  // otherwise spend the budget on nothing — and it keeps every space below
  // exactly one character wide, which is what bounds the `trimEnd` at the end.
  const firstLine = (text ?? "").split("\n")[0].replace(/\s+/g, " ").trim();
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

  // Drop a trailing partial word so the title doesn't end mid-word — but only
  // when a word is actually being split. If the character we're dropping is the
  // space *after* a whole word, nothing is partial, and backing up would discard
  // that complete word for nothing.
  if (codePoints[MAX_TITLE_LENGTH - 1] !== " ") {
    const atBoundary = body.replace(/ [^ ]*$/, "");
    // Count code points, not UTF-16 units: 25 emoji are 50 units but only 25
    // characters of title, and the floor is about how much title is left.
    if ([...atBoundary].length >= MIN_ELIDED_TITLE_LENGTH) {
      body = atBoundary;
    }
  }

  // At most one space can remain (runs are collapsed above), so the ellipsis
  // never follows a space ("Bob …") and this can't drop below the floor.
  return `${body.trimEnd()}…`;
}

/**
 * Render an image attached to a post.
 *
 * Plugin HTML is a bare body fragment, so the save path's own `og:image` scrape
 * never sees the source page — inlining the image here is the only way it
 * survives the save. No alt text: none of these sources expose any, and
 * inventing one is worse than leaving it empty.
 */
export function socialPostImage(url: string): string {
  return `<figure><img src="${escapeHtml(url)}" alt="" loading="lazy"></figure>`;
}

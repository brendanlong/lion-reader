/**
 * HTML Utilities
 *
 * Common HTML processing utilities used across the server.
 *
 * For extracting plain text from HTML, use `stripHtml` from
 * `@/server/html/strip-html` (streaming SAX parse).
 */

/**
 * Escapes HTML special characters for safe embedding in HTML.
 *
 * Replaces:
 * - & → &amp;
 * - < → &lt;
 * - > → &gt;
 * - " → &quot;
 * - ' → &#039;
 *
 * @param text - The text to escape
 * @returns The escaped text safe for HTML embedding
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Wraps bare http(s) URLs in already-HTML-escaped text with <a> tags. Escaped
 * text contains no raw `<`/`"`, so a match is safe to place in an href
 * attribute as-is (entities like `&amp;` decode back to the original URL).
 */
function linkifyEscapedText(escapedText: string): string {
  return escapedText.replace(/https?:\/\/[^\s]+/g, (match) => {
    // Trailing sentence punctuation is almost never part of the URL; a
    // trailing `)` only is when the URL itself contains `(`.
    let url = match.replace(/[.,!?]+$/, "");
    if (url.endsWith(")") && !url.includes("(")) {
      url = url.slice(0, -1);
    }
    const trailer = match.slice(url.length);
    return `<a href="${url}">${url}</a>${trailer}`;
  });
}

/**
 * Renders a plain-text body as HTML: escapes it, turns blank-line-separated
 * blocks into paragraphs (single newlines into `<br>`), and links bare http(s)
 * URLs.
 *
 * Shared by every source whose upstream hands us prose as plain text rather
 * than HTML — YouTube video descriptions, LinkedIn post bodies, Threads posts —
 * so all of them render identically. Returns "" for blank input.
 */
export function plainTextToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => linkifyEscapedText(escapeHtml(block.trim())).replace(/\n/g, "<br>"))
    .filter((block) => block.length > 0)
    .map((block) => `<p>${block}</p>`)
    .join("");
}

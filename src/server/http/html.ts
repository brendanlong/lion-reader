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

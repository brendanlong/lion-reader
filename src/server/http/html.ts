/**
 * HTML Utilities
 *
 * Common HTML processing utilities used across the server.
 */

import { parseHTML } from "linkedom";

/**
 * Extracts plain text from HTML content.
 *
 * Uses linkedom for proper parsing rather than regex, which correctly
 * handles nested tags, script/style content, and entity decoding.
 *
 * @param html - The HTML content to extract text from
 * @returns The plain text content
 */
export function extractTextFromHtml(html: string): string {
  if (!html || !html.trim()) {
    return "";
  }

  // Wrap fragments in a full HTML document structure for proper parsing
  // linkedom requires a proper document structure
  const trimmedHtml = html.trim().toLowerCase();
  const isFullDocument = trimmedHtml.startsWith("<!doctype") || trimmedHtml.startsWith("<html");
  const htmlToParse = isFullDocument ? html : `<!DOCTYPE html><html><body>${html}</body></html>`;

  const { document } = parseHTML(htmlToParse);

  // Remove script and style elements
  for (const el of document.querySelectorAll("script, style")) {
    el.remove();
  }

  // Get text content, collapse whitespace
  return (document.body?.textContent || document.documentElement?.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
}

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
 * Wraps an HTML fragment in a full document structure.
 *
 * Used by plugins that return content fragments (e.g., from APIs) to ensure
 * consistent document structure for metadata extraction and Readability.
 *
 * @param html - The HTML fragment to wrap
 * @param title - Optional title for the document
 * @returns A complete HTML document
 */
export function wrapHtmlFragment(html: string, title?: string | null): string {
  const titleTag = title ? `<title>${escapeHtml(title)}</title>` : "";
  return `<!DOCTYPE html><html><head>${titleTag}</head><body>${html}</body></html>`;
}

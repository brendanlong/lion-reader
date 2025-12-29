/**
 * Client-safe HTML to Plain Text Converter
 *
 * A simple regex-based converter that can run in both browser and server environments.
 * For narration without LLM preprocessing.
 *
 * @module narration/html-to-plain-text
 */

/**
 * Converts HTML to plain text for narration.
 * Uses regex-based conversion that works in any JavaScript environment.
 *
 * @param html - HTML content to convert
 * @returns Plain text with paragraph breaks
 *
 * @example
 * const text = htmlToPlainText('<p>Hello</p><p>World</p>');
 * // Returns "Hello\n\nWorld"
 */
export function htmlToPlainText(html: string): string {
  return (
    html
      // Add paragraph breaks before block elements
      .replace(/<(p|div|br|h[1-6]|li|tr|blockquote|pre)[^>]*>/gi, "\n\n")
      // Remove all HTML tags
      .replace(/<[^>]+>/g, "")
      // Decode common HTML entities
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      // Normalize whitespace: collapse multiple spaces to single space
      .replace(/ +/g, " ")
      // Normalize paragraph breaks: collapse multiple newlines to double newline
      .replace(/\n{3,}/g, "\n\n")
      // Trim whitespace from each line
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      // Final trim
      .trim()
  );
}

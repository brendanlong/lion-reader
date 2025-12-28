/**
 * HTML to Narration Input Converter
 *
 * This module converts HTML content to structured text with paragraph markers
 * for LLM processing. It's a pure function with no I/O dependencies.
 *
 * @module narration/html-to-narration-input
 */

/**
 * Result of converting HTML to narration input.
 */
export interface HtmlToNarrationInputResult {
  /** Text content with [P:X] markers for LLM processing */
  inputText: string;
  /** Array of paragraph identifiers in order they appear */
  paragraphOrder: string[];
}

/**
 * Converts HTML to structured text for LLM processing with paragraph markers.
 * Preserves semantic information like headings, lists, code blocks, and images
 * to help the LLM generate appropriate narration.
 *
 * Adds [P:X] markers to indicate original paragraph indices, which the LLM
 * will transform to [PARA:X] markers in its output for highlighting support.
 *
 * @param html - HTML content to convert
 * @returns Object with inputText (marked text) and paragraphOrder (paragraph IDs)
 *
 * @example
 * const result = htmlToNarrationInput('<h2>Title</h2><p>Content</p>');
 * // Returns {
 * //   inputText: "[P:0] [HEADING] Title\n\n[P:1] Content",
 * //   paragraphOrder: ["para-0", "para-1"]
 * // }
 */
export function htmlToNarrationInput(html: string): HtmlToNarrationInputResult {
  // Track paragraph indices
  let paragraphIndex = 0;
  const paragraphOrder: string[] = [];

  /**
   * Generates the next paragraph marker and records it.
   */
  function nextMarker(): string {
    const id = `para-${paragraphIndex}`;
    paragraphOrder.push(id);
    const marker = `[P:${paragraphIndex}]`;
    paragraphIndex++;
    return marker;
  }

  let result = html;

  // Process headings with paragraph markers
  result = result.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [HEADING] ${content}\n\n`;
  });
  result = result.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [HEADING] ${content}\n\n`;
  });
  result = result.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [SUBHEADING] ${content}\n\n`;
  });
  result = result.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [SUBHEADING] ${content}\n\n`;
  });

  // Mark code blocks with paragraph markers
  result = result.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [CODE BLOCK]\n${content}\n[END CODE BLOCK]\n\n`;
  });
  result = result.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [CODE BLOCK]\n${content}\n[END CODE BLOCK]\n\n`;
  });

  // Mark inline code (but don't add line breaks or markers)
  result = result.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Mark blockquotes with paragraph markers
  result = result.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [QUOTE]\n${content}\n[END QUOTE]\n\n`;
  });

  // Handle images - extract alt text with paragraph markers
  result = result.replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, (_, alt) => {
    const marker = nextMarker();
    return `\n\n${marker} [IMAGE: ${alt}]\n\n`;
  });
  result = result.replace(/<img[^>]*>/gi, () => {
    const marker = nextMarker();
    return `\n\n${marker} [IMAGE: no description]\n\n`;
  });

  // Handle links - preserve link text, add URL for context (no markers, inline)
  result = result.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, text) => {
    const cleanText = text.trim();
    // If link text is the same as URL or empty, just show domain
    if (!cleanText || cleanText === url) {
      try {
        const domain = new URL(url).hostname;
        return `[link to ${domain}]`;
      } catch {
        return `[link to ${url}]`;
      }
    }
    // Otherwise, just use the link text (LLM will handle it)
    return cleanText;
  });

  // Handle lists - mark list items with paragraph markers
  result = result.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n${marker} - ${content}`;
  });
  result = result.replace(/<\/?[ou]l[^>]*>/gi, "\n");

  // Handle tables - mark them for LLM to process with paragraph markers
  result = result.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [TABLE]\n${content}\n[END TABLE]\n\n`;
  });
  result = result.replace(/<tr[^>]*>/gi, "\n[ROW] ");
  result = result.replace(/<\/tr>/gi, "");
  result = result.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, "$1 | ");

  // Handle paragraphs with paragraph markers
  result = result.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} ${content}\n\n`;
  });

  // Handle divs (no markers, they're containers)
  result = result.replace(/<div[^>]*>/gi, "\n\n");
  result = result.replace(/<\/div>/gi, "\n\n");

  // Handle line breaks
  result = result.replace(/<br\s*\/?>/gi, "\n");

  // Remove remaining HTML tags
  result = result.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  result = result.replace(/&nbsp;/g, " ");
  result = result.replace(/&amp;/g, "&");
  result = result.replace(/&lt;/g, "<");
  result = result.replace(/&gt;/g, ">");
  result = result.replace(/&quot;/g, '"');
  result = result.replace(/&#39;/g, "'");
  result = result.replace(/&apos;/g, "'");

  // Normalize whitespace
  result = result.replace(/ +/g, " ");
  result = result.replace(/\n{3,}/g, "\n\n");
  result = result
    .split("\n")
    .map((line) => line.trim())
    .join("\n");

  return {
    inputText: result.trim(),
    paragraphOrder,
  };
}

/**
 * Converts HTML to plain text for fallback mode.
 * Basic conversion that strips tags but preserves structure.
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

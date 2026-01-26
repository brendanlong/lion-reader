/**
 * Markdown Processing Utilities
 *
 * Centralized Markdown-to-HTML conversion with title extraction.
 * Used by file uploads, URL fetching, and plugins.
 */

import { marked } from "marked";
import { extractAndStripTitleHeader } from "@/server/html/strip-title-header";

/**
 * Converts Markdown to HTML using marked with safe defaults.
 *
 * @param markdown - The Markdown text to convert
 * @returns The HTML representation
 */
export async function markdownToHtml(markdown: string): Promise<string> {
  // Configure marked for safe rendering
  marked.setOptions({
    gfm: true, // GitHub Flavored Markdown
    breaks: true, // Convert \n to <br>
  });

  return marked.parse(markdown) as Promise<string>;
}

/**
 * Result of converting and processing Markdown.
 */
export interface ProcessedMarkdown {
  /** HTML content with title header stripped */
  html: string;
  /** Extracted title from first heading (if any) */
  title: string | null;
}

/**
 * Converts Markdown to HTML and extracts the title from the first heading.
 *
 * This is the primary function to use when processing Markdown content,
 * as it handles both conversion and title extraction in one step.
 *
 * @param markdown - The Markdown text to convert
 * @returns HTML content and extracted title
 */
export async function processMarkdown(markdown: string): Promise<ProcessedMarkdown> {
  // Convert to HTML
  const html = await markdownToHtml(markdown);

  // Extract and strip title header
  const { title, content } = extractAndStripTitleHeader(html);

  return {
    html: content,
    title,
  };
}

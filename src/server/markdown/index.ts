/**
 * Markdown Processing Utilities
 *
 * Centralized Markdown-to-HTML conversion with title extraction and frontmatter parsing.
 * Used by file uploads, URL fetching, and plugins.
 */

import { marked } from "marked";
import { parse as parseYaml } from "yaml";
import { extractAndStripTitleHeader } from "@/server/html/strip-title-header";

/**
 * Result of parsing YAML frontmatter from Markdown.
 */
export interface Frontmatter {
  /** Title from frontmatter */
  title?: string;
  /** Description/summary from frontmatter */
  description?: string;
  /** Raw frontmatter object for future extensibility */
  raw: Record<string, unknown>;
}

/**
 * Result of stripping frontmatter from Markdown.
 */
interface FrontmatterResult {
  /** Frontmatter data if present, null otherwise */
  frontmatter: Frontmatter | null;
  /** Markdown content with frontmatter removed */
  content: string;
}

// Regex to match YAML frontmatter at the start of a document
// Must start with --- on its own line, end with --- on its own line
const FRONTMATTER_REGEX = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Extracts and parses YAML frontmatter from Markdown content.
 *
 * @param markdown - The Markdown text that may contain frontmatter
 * @returns Parsed frontmatter and remaining content
 */
export function extractFrontmatter(markdown: string): FrontmatterResult {
  const match = FRONTMATTER_REGEX.exec(markdown);

  if (!match) {
    return { frontmatter: null, content: markdown };
  }

  const yamlContent = match[1];
  const contentWithoutFrontmatter = markdown.slice(match[0].length);

  try {
    const parsed = parseYaml(yamlContent);

    // Ensure we got an object
    if (typeof parsed !== "object" || parsed === null) {
      return { frontmatter: null, content: markdown };
    }

    const frontmatter: Frontmatter = {
      raw: parsed as Record<string, unknown>,
    };

    // Extract title if present and is a string
    if (typeof parsed.title === "string" && parsed.title.trim()) {
      frontmatter.title = parsed.title.trim();
    }

    // Extract description if present and is a string
    if (typeof parsed.description === "string" && parsed.description.trim()) {
      frontmatter.description = parsed.description.trim();
    }

    return { frontmatter, content: contentWithoutFrontmatter };
  } catch {
    // YAML parsing failed, treat as no frontmatter
    return { frontmatter: null, content: markdown };
  }
}

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
  /** Extracted title from frontmatter or first heading (if any) */
  title: string | null;
  /** Summary/description from frontmatter (if any) */
  summary: string | null;
}

/**
 * Converts Markdown to HTML and extracts metadata.
 *
 * This is the primary function to use when processing Markdown content.
 * It handles:
 * 1. YAML frontmatter detection and parsing (title, description)
 * 2. Markdown to HTML conversion
 * 3. Title extraction from first heading (if not in frontmatter)
 *
 * Priority for title: frontmatter.title > first H1 heading
 *
 * @param markdown - The Markdown text to convert
 * @returns HTML content, extracted title, and summary
 */
export async function processMarkdown(markdown: string): Promise<ProcessedMarkdown> {
  // Extract frontmatter if present
  const { frontmatter, content: markdownWithoutFrontmatter } = extractFrontmatter(markdown);

  // Convert remaining markdown to HTML
  const html = await markdownToHtml(markdownWithoutFrontmatter);

  // Extract and strip title header from HTML
  const { title: headerTitle, content: htmlWithoutHeader } = extractAndStripTitleHeader(html);

  // Frontmatter title takes priority over header title
  const title = frontmatter?.title ?? headerTitle;

  // Summary comes from frontmatter description
  const summary = frontmatter?.description ?? null;

  return {
    html: htmlWithoutHeader,
    title,
    summary,
  };
}

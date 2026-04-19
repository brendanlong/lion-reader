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
  /** Author from frontmatter */
  author?: string;
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

  // Try strict YAML parsing first
  try {
    const parsed = parseYaml(yamlContent);

    // Ensure we got an object
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return {
        frontmatter: buildFrontmatter(parsed as Record<string, unknown>),
        content: contentWithoutFrontmatter,
      };
    }
  } catch {
    // Strict YAML failed (e.g. unquoted colons in values), try lenient parsing
  }

  // Lenient fallback: parse simple "key: value" lines.
  // Handles common frontmatter that isn't strictly valid YAML,
  // e.g. "title: Parcae: Doing more..." where the colon in the value
  // causes a YAML nested mapping error.
  const lenient = parseFrontmatterLenient(yamlContent);
  if (lenient) {
    return { frontmatter: buildFrontmatter(lenient), content: contentWithoutFrontmatter };
  }

  // Even if we can't parse the frontmatter, still strip it from content
  return { frontmatter: null, content: contentWithoutFrontmatter };
}

/**
 * Builds a Frontmatter object from a parsed key-value record.
 */
function buildFrontmatter(raw: Record<string, unknown>): Frontmatter {
  const frontmatter: Frontmatter = { raw };

  if (typeof raw.title === "string" && raw.title.trim()) {
    frontmatter.title = raw.title.trim();
  }

  if (typeof raw.description === "string" && raw.description.trim()) {
    frontmatter.description = raw.description.trim();
  }

  if (typeof raw.author === "string" && raw.author.trim()) {
    frontmatter.author = raw.author.trim();
  }

  return frontmatter;
}

/**
 * Lenient frontmatter parser for when strict YAML parsing fails.
 *
 * Parses simple single-line "key: value" pairs, taking everything after
 * the first colon as the value. This handles common cases like unquoted
 * colons in values (e.g. "title: Parcae: Doing more...").
 *
 * Does not handle multi-line values, nested objects, or arrays.
 */
function parseFrontmatterLenient(yaml: string): Record<string, string> | null {
  const result: Record<string, string> = {};

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex <= 0) return null; // Not a key: value line

    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();

    // Keys must be simple identifiers
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)) return null;

    if (key && value) {
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
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
  /** Author from frontmatter (if any) */
  author: string | null;
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

  // Author comes from frontmatter
  const author = frontmatter?.author ?? null;

  return {
    html: htmlWithoutHeader,
    title,
    summary,
    author,
  };
}

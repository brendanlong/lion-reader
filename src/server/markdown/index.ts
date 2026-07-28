/**
 * Markdown Processing Utilities
 *
 * Centralized Markdown-to-HTML conversion with title extraction and frontmatter parsing.
 * Used by file uploads, URL fetching, and plugins.
 *
 * The dialect — GitHub Flavored Markdown plus `$…$` / `$$…$$` TeX rendered to
 * MathML — lives in the native renderer (`native/markdown/`, comrak +
 * pulldown-latex). Every Markdown source in the app renders through it, so
 * there is one dialect to reason about and one place to extend (a lint rule
 * enforces it; see "Parsing" in CLAUDE.md). This module owns the surrounding
 * document concerns: frontmatter, title extraction, and the size budgets.
 *
 * Rendering is native because it is the most expensive step in the content
 * pipeline and used to be the only one that could block the event loop (#1431)
 * — it now offloads to the libuv thread pool the same way sanitization and
 * Readability extraction do.
 */

import { renderMarkdown, renderMarkdownAsync } from "@lion-reader/markdown";
import type { MarkdownLimits, RenderedMarkdown } from "@lion-reader/markdown";
import { parse as parseYaml } from "yaml";
import { usageLimitsConfig } from "@/server/config/env";
import { extractAndStripTitleHeader } from "@/server/html/strip-title-header";
import { startMarkdownRenderTimer } from "@/server/metrics/metrics";
import { errors } from "@/server/trpc/errors";

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

// Regex to match YAML frontmatter at the start of a document.
// Must start with --- on its own line, and end with either --- or ... on its
// own line. YAML uses `...` as an explicit end-of-document marker, and tools
// like Pandoc (e.g. gwern.net) close frontmatter with it. Accepting only `---`
// as the closer made the lazy body matcher run past a `...` terminator and latch
// onto the first later `---` thematic break, silently swallowing the whole intro
// as "frontmatter" (see #1280).
const FRONTMATTER_REGEX = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

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
 * Documents at or below this size render synchronously on the calling thread:
 * the native renderer handles them in well under a millisecond, so the fixed
 * cost of scheduling a libuv-thread-pool task (and copying the string across
 * the N-API boundary twice) isn't worth paying. ~10 KB, same rationale and
 * value as the sanitizer's and the extractor's inline thresholds.
 */
const RENDER_INLINE_MAX_CHARS = 10 * 1024;

function renderLimits(): MarkdownLimits {
  return {
    maxInputBytes: usageLimitsConfig.maxMarkdownInputBytes,
    maxOutputBytes: usageLimitsConfig.maxRenderedMarkdownBytes,
  };
}

/**
 * Turns a budget rejection into the same user-facing "content too large" error
 * every other size limit produces.
 *
 * The budgets are checked inside the renderer rather than by callers because
 * Markdown *grows*: math-dense input expands ~10x, so a document that passes a
 * raw-bytes check on the way in can still blow up on the way out. Checking
 * afterwards meant paying for the whole expansion first (#1431).
 */
function unwrapRendered(result: RenderedMarkdown): string {
  if (result.limitExceeded === undefined) {
    return result.html;
  }
  if (result.limitExceeded === "input") {
    throw errors.contentTooLarge("Markdown content", usageLimitsConfig.maxMarkdownInputBytes);
  }
  throw errors.contentTooLarge(
    "Rendered Markdown content",
    usageLimitsConfig.maxRenderedMarkdownBytes
  );
}

/**
 * The inline path. Not exported: every Markdown source in the app is reached
 * from a request (saves, uploads, plugin fetches, summary generation), and none
 * from a background job, so there is no caller that should be choosing the
 * blocking form. If one ever appears — the sanitizer and the Readability
 * extractor both have background-job callers that legitimately use their sync
 * forms — export this rather than inlining a second `renderMarkdown` call.
 */
function renderInline(markdown: string): string {
  const stopTimer = startMarkdownRenderTimer();
  try {
    return unwrapRendered(renderMarkdown(markdown, renderLimits()));
  } finally {
    stopTimer();
  }
}

/**
 * Converts Markdown to HTML. Use this when there is no document metadata to
 * extract (an AI summary); use {@link processMarkdown} for a document with
 * frontmatter and a title.
 *
 * The render runs on the libuv thread pool for documents above the inline
 * threshold, so a large one never blocks the event loop that serves UI
 * requests.
 *
 * @throws if the source or the rendered HTML exceeds its byte budget.
 */
export async function markdownToHtmlAsync(markdown: string): Promise<string> {
  // Small documents go through the inline path, which records its own timing.
  if (markdown.length <= RENDER_INLINE_MAX_CHARS) {
    return renderInline(markdown);
  }

  const stopTimer = startMarkdownRenderTimer();
  try {
    return unwrapRendered(await renderMarkdownAsync(markdown, renderLimits()));
  } finally {
    stopTimer();
  }
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
 * @throws if the source or the rendered HTML exceeds its byte budget.
 */
export async function processMarkdown(markdown: string): Promise<ProcessedMarkdown> {
  // Extract frontmatter if present
  const { frontmatter, content: markdownWithoutFrontmatter } = extractFrontmatter(markdown);

  // Convert remaining markdown to HTML. Every caller is a request path (saves,
  // uploads, plugin fetches), so this offloads large documents.
  const html = await markdownToHtmlAsync(markdownWithoutFrontmatter);

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

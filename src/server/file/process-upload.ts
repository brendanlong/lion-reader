/**
 * File upload processing module.
 *
 * Handles conversion of uploaded files to HTML for storage as saved articles.
 * Supports:
 * - .docx files → mammoth conversion → Readability cleaning
 * - .html files → Readability cleaning
 * - .md files → marked conversion (no cleaning needed)
 */

import * as mammoth from "mammoth";
import { cleanContentInWorker } from "@/server/worker-thread/pool";
import { generateSummary } from "@/server/html/strip-html";
import { logger } from "@/lib/logger";
import { processMarkdown as convertMarkdown } from "@/server/markdown";

// ============================================================================
// Types
// ============================================================================

/**
 * Supported file types for upload.
 */
export type SupportedFileType = "docx" | "html" | "markdown";

/**
 * Result from processing an uploaded file.
 */
export interface ProcessedFile {
  /** The cleaned/converted HTML content */
  contentCleaned: string;
  /** Plain text excerpt for preview */
  excerpt: string | null;
  /** Extracted or derived title (from filename or content) */
  title: string | null;
  /** Extracted author (from frontmatter, metadata, or Readability) */
  author: string | null;
  /** Original file type */
  fileType: SupportedFileType;
}

// ============================================================================
// File Type Detection
// ============================================================================

/**
 * Determines file type from filename extension.
 *
 * @param filename - The uploaded file's name
 * @returns The detected file type, or null if unsupported
 */
export function detectFileType(filename: string): SupportedFileType | null {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".docx")) {
    return "docx";
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return "html";
  }
  // Treat both markdown and plain text as markdown - the markdown processor
  // handles plain text fine (it just renders it as-is, wrapped in paragraphs)
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt")) {
    return "markdown";
  }

  return null;
}

/**
 * Extracts a title from a filename by removing the extension.
 */
function titleFromFilename(filename: string): string {
  // Remove extension
  let title = filename.replace(/\.(docx|html?|md|markdown|txt)$/i, "");

  // Clean up common patterns
  title = title
    // Replace underscores and hyphens with spaces
    .replace(/[_-]+/g, " ")
    // Remove multiple spaces
    .replace(/\s+/g, " ")
    .trim();

  return title;
}

// ============================================================================
// File Processors
// ============================================================================

/**
 * Converts a .docx file buffer to HTML using mammoth, then cleans with Readability.
 */
async function processDocx(buffer: Buffer, filename: string): Promise<ProcessedFile> {
  const styleMap = ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"];

  const result = await mammoth.convertToHtml({ buffer }, { styleMap });

  if (result.messages.length > 0) {
    logger.debug("Mammoth conversion messages", {
      filename,
      messages: result.messages.map((m) => m.message),
    });
  }

  const rawHtml = result.value;

  // Wrap in HTML structure for Readability
  const fullHtml = `<!DOCTYPE html><html><body>${rawHtml}</body></html>`;

  // Clean with Readability
  const cleaned = await cleanContentInWorker(fullHtml, { minCleanedLength: 10 });

  // Use cleaned content if available, otherwise use raw mammoth output
  const contentCleaned = cleaned?.content ?? rawHtml;
  const excerpt = cleaned ? generateSummary(cleaned.content) : generateSummary(rawHtml);

  return {
    contentCleaned,
    excerpt: excerpt || null,
    title: cleaned?.title || titleFromFilename(filename),
    author: cleaned?.byline || null,
    fileType: "docx",
  };
}

/**
 * Processes an HTML file by cleaning with Readability.
 */
async function processHtml(content: string, filename: string): Promise<ProcessedFile> {
  // Clean with Readability
  const cleaned = await cleanContentInWorker(content, { minCleanedLength: 10 });

  if (cleaned) {
    return {
      contentCleaned: cleaned.content,
      excerpt: cleaned.excerpt || generateSummary(cleaned.content) || null,
      title: cleaned.title || titleFromFilename(filename),
      author: cleaned.byline || null,
      fileType: "html",
    };
  }

  // If Readability fails, return the raw HTML (sanitization happens on display)
  return {
    contentCleaned: content,
    excerpt: generateSummary(content) || null,
    title: titleFromFilename(filename),
    author: null,
    fileType: "html",
  };
}

/**
 * Converts Markdown to HTML using marked.
 * Markdown content is kept as-is semantically, just rendered to HTML.
 * Supports YAML frontmatter for title, description, and author extraction.
 */
async function processMarkdown(content: string, filename: string): Promise<ProcessedFile> {
  // Convert markdown to HTML and extract title/summary/author from frontmatter or content
  const {
    html: contentCleaned,
    title: extractedTitle,
    summary: frontmatterSummary,
    author,
  } = await convertMarkdown(content);
  const title = extractedTitle || titleFromFilename(filename);

  // Prefer frontmatter description, fall back to generated summary from content
  const excerpt = frontmatterSummary ?? generateSummary(contentCleaned);

  return {
    contentCleaned,
    excerpt: excerpt || null,
    title,
    author,
    fileType: "markdown",
  };
}

// ============================================================================
// Main Processing Function
// ============================================================================

/**
 * Processes an uploaded file and converts it to HTML for storage.
 *
 * @param content - The file content (Buffer for binary files, string for text)
 * @param filename - The original filename (used for type detection and title)
 * @returns Processed file with HTML content, or throws if unsupported type
 *
 * @example
 * ```typescript
 * // For a docx file
 * const result = await processUploadedFile(buffer, "document.docx");
 *
 * // For a markdown file
 * const result = await processUploadedFile(mdContent, "notes.md");
 * ```
 */
export async function processUploadedFile(
  content: Buffer | string,
  filename: string
): Promise<ProcessedFile> {
  const fileType = detectFileType(filename);

  if (!fileType) {
    throw new Error(
      `Unsupported file type. Supported types: .docx, .html, .htm, .md, .markdown, .txt`
    );
  }

  logger.info("Processing uploaded file", { filename, fileType });

  switch (fileType) {
    case "docx": {
      // docx requires Buffer
      const buffer = typeof content === "string" ? Buffer.from(content, "base64") : content;
      return processDocx(buffer, filename);
    }

    case "html": {
      // HTML should be string
      const htmlContent = typeof content === "string" ? content : content.toString("utf-8");
      return processHtml(htmlContent, filename);
    }

    case "markdown": {
      // Markdown should be string (also handles plain text files)
      const mdContent = typeof content === "string" ? content : content.toString("utf-8");
      return processMarkdown(mdContent, filename);
    }
  }
}

/**
 * Gets a human-readable description of supported file types.
 */
export function getSupportedTypesDescription(): string {
  return "Word documents (.docx), HTML files (.html), Markdown files (.md), and text files (.txt)";
}

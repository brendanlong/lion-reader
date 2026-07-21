/**
 * File upload conversion module.
 *
 * Converts an uploaded file to raw article HTML. This is only the *acquisition*
 * step — Readability cleaning, excerpt generation, and metadata (title / author /
 * site name) all happen downstream in `buildArticleFields` (see `saved.ts`), so
 * uploads share exactly the same processing as URL saves.
 *
 * Supports:
 * - .docx files → mammoth conversion + `docProps/core.xml` metadata (Readability
 *   skipped downstream — mammoth output is already clean, chrome-free content, so
 *   running Readability only risks over-stripping; like a Markdown URL save)
 * - .html files → passthrough (Readability runs downstream)
 * - .md/.txt files → marked conversion (Readability skipped downstream, like a
 *   Markdown URL save)
 */

import * as mammoth from "mammoth";
import { logger } from "@/lib/logger";
import { processMarkdown as convertMarkdown } from "@/server/markdown";
import { extractDocxCoreProperties } from "@/server/file/docx-core-props";

// ============================================================================
// Types
// ============================================================================

/**
 * Supported file types for upload.
 */
export type SupportedFileType = "docx" | "html" | "markdown";

/**
 * Raw content produced by converting an uploaded file. Fed to `buildArticleFields`
 * as an article content bundle (with a null URL).
 */
export interface ConvertedUpload {
  /** Raw article HTML (stored as content_original; Readability runs on it downstream). */
  html: string;
  /**
   * Pre-cleaned content — set for .md/.txt (marked) and .docx (mammoth +
   * core.xml), null for .html. A non-null value tells `buildArticleFields` to
   * skip Readability (the content is already clean) and use the supplied
   * title/summary/author (Markdown frontmatter, or docx `docProps/core.xml`).
   */
  preCleanedContent: {
    html: string;
    title: string | null;
    summary: string | null;
    author: string | null;
  } | null;
  /** Detected file type (drives the display site name). */
  fileType: SupportedFileType;
  /** Original filename, used downstream as a last-resort title. */
  filename: string;
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
 * Extracts a title from a filename by removing the extension. Used downstream as
 * a last-resort title when nothing better could be extracted from the content.
 */
export function titleFromFilename(filename: string): string {
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
// File Converters
// ============================================================================

/**
 * Converts a .docx file buffer to HTML using mammoth, and reads the author-set
 * document properties (`docProps/core.xml`) for title/author/summary.
 *
 * Readability is skipped downstream (via `preCleanedContent`): mammoth emits a
 * flat, chrome-free run of `<p>`/`<h1>`, so Readability adds no cleaning and only
 * risks promoting the first paragraph as a bogus title or dropping content. The
 * real `core.xml` metadata is far more reliable than anything guessed from the
 * rendered HTML; where it's absent, downstream falls back to the filename.
 */
async function convertDocx(buffer: Buffer, filename: string): Promise<ConvertedUpload> {
  const styleMap = ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"];

  const result = await mammoth.convertToHtml({ buffer }, { styleMap });

  if (result.messages.length > 0) {
    logger.debug("Mammoth conversion messages", {
      filename,
      messages: result.messages.map((m) => m.message),
    });
  }

  // Read the author-set document properties. jszip's lazy read only inflates
  // that one small ZIP entry (not the whole archive).
  const coreProps = await extractDocxCoreProperties(buffer);

  return {
    html: result.value,
    preCleanedContent: {
      html: result.value,
      title: coreProps.title,
      summary: coreProps.description,
      author: coreProps.author,
    },
    fileType: "docx",
    filename,
  };
}

/**
 * Converts Markdown to HTML using marked. Frontmatter title/description/author
 * are extracted here and passed through as the markdown result so downstream
 * treats it like a Markdown URL save (Readability skipped).
 */
async function convertMarkdownFile(content: string, filename: string): Promise<ConvertedUpload> {
  const { html, title, summary, author } = await convertMarkdown(content);
  return {
    html,
    preCleanedContent: { html, title, summary, author },
    fileType: "markdown",
    filename,
  };
}

// ============================================================================
// Main Conversion Function
// ============================================================================

/**
 * Converts an uploaded file to raw article content for `buildArticleFields`.
 *
 * @param content - The file content (Buffer for binary files, string for text)
 * @param filename - The original filename (used for type detection and title)
 * @returns The converted content, or throws if the type is unsupported
 */
export async function convertUploadedFile(
  content: Buffer | string,
  filename: string
): Promise<ConvertedUpload> {
  const fileType = detectFileType(filename);

  if (!fileType) {
    throw new Error(
      `Unsupported file type. Supported types: .docx, .html, .htm, .md, .markdown, .txt`
    );
  }

  logger.info("Converting uploaded file", { filename, fileType });

  switch (fileType) {
    case "docx": {
      // docx requires Buffer
      const buffer = typeof content === "string" ? Buffer.from(content, "base64") : content;
      return convertDocx(buffer, filename);
    }

    case "html": {
      // HTML should be string; Readability runs downstream.
      const htmlContent = typeof content === "string" ? content : content.toString("utf-8");
      return { html: htmlContent, preCleanedContent: null, fileType: "html", filename };
    }

    case "markdown": {
      // Markdown should be string (also handles plain text files)
      const mdContent = typeof content === "string" ? content : content.toString("utf-8");
      return convertMarkdownFile(mdContent, filename);
    }
  }
}

/**
 * Gets a human-readable description of supported file types.
 */
export function getSupportedTypesDescription(): string {
  return "Word documents (.docx), HTML files (.html), Markdown files (.md), and text files (.txt)";
}

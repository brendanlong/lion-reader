/**
 * File upload conversion module.
 *
 * Converts an uploaded file to raw article HTML. This is only the *acquisition*
 * step — Readability cleaning, excerpt generation, and metadata (title / author /
 * site name) all happen downstream in `buildArticleFields` (see `saved-content.ts`), so
 * uploads share exactly the same processing as URL saves.
 *
 * Supports:
 * - .docx files → mammoth conversion + `docProps/core.xml` metadata (Readability
 *   skipped downstream — mammoth output is already clean, chrome-free content, so
 *   running Readability only risks over-stripping; like a Markdown URL save)
 * - .pdf files → text and layout via `lion-reader-pdf`, rendered as Markdown,
 *   with document-info metadata (Readability skipped downstream, as for .docx)
 * - .html files → passthrough (Readability runs downstream)
 * - .md/.txt files → Markdown rendering (Readability skipped downstream, like a
 *   Markdown URL save)
 */

import { decodeBody } from "@/server/http/charset";
import { logger } from "@/lib/logger";
import { markdownToHtmlAsync, processMarkdown as convertMarkdown } from "@/server/markdown";
import { stripTitleHeader } from "@/server/html/strip-title-header";
import { extractDocxCoreProperties } from "@/server/file/docx-core-props";
import { convertDocxToHtml } from "@/server/file/docx-to-html";
import { convertPdfToMarkdown } from "@/server/file/pdf-to-markdown";
import {
  SUPPORTED_UPLOAD_EXTENSIONS,
  UPLOAD_FILE_TYPES,
  type SupportedFileType,
} from "@/lib/upload-file-types";

// ============================================================================
// Types
// ============================================================================

/**
 * Raw content produced by converting an uploaded file. Fed to `buildArticleFields`
 * as an article content bundle (with a null URL).
 */
export interface ConvertedUpload {
  /** Raw article HTML (content_original, absolutized; Readability runs on it downstream). */
  html: string;
  /**
   * Pre-cleaned content — set for .md/.txt (Markdown), .docx (mammoth +
   * core.xml) and .pdf, null for .html. A non-null value tells `buildArticleFields` to
   * skip Readability (the content is already clean) and use the supplied
   * title/summary/author (Markdown frontmatter, docx `docProps/core.xml`, or
   * the PDF's document info).
   */
  preCleanedContent: {
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
  const ext = SUPPORTED_UPLOAD_EXTENSIONS.find((e) => lower.endsWith(e));
  return ext ? UPLOAD_FILE_TYPES[ext] : null;
}

/**
 * Extracts a title from a filename by removing the extension. Used downstream as
 * a last-resort title when nothing better could be extracted from the content.
 */
export function titleFromFilename(filename: string): string {
  // Remove extension
  let title = filename.replace(/\.(docx|pdf|html?|md|markdown|txt)$/i, "");

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
  const html = await convertDocxToHtml(buffer);

  // Read the author-set document properties. jszip's lazy read only inflates
  // that one small ZIP entry (not the whole archive).
  const coreProps = await extractDocxCoreProperties(buffer);

  return {
    html,
    preCleanedContent: {
      title: coreProps.title,
      summary: coreProps.description,
      author: coreProps.author,
    },
    fileType: "docx",
    filename,
  };
}

/**
 * Converts a PDF via its extracted Markdown. Not through `processMarkdown`: PDF
 * text is never frontmatter, and the title comes from the document, so the
 * first heading is only dropped when it repeats that title.
 */
async function convertPdf(buffer: Buffer, filename: string): Promise<ConvertedUpload> {
  const pdf = await convertPdfToMarkdown(buffer);
  const html = await markdownToHtmlAsync(pdf.markdown);
  return {
    html: pdf.title ? stripTitleHeader(html, pdf.title) : html,
    preCleanedContent: { title: pdf.title, summary: pdf.summary, author: pdf.author },
    fileType: "pdf",
    filename,
  };
}

/**
 * Converts Markdown to HTML. Frontmatter title/description/author
 * are extracted here and passed through as the markdown result so downstream
 * treats it like a Markdown URL save (Readability skipped).
 */
async function convertMarkdownFile(content: string, filename: string): Promise<ConvertedUpload> {
  const { html, title, summary, author } = await convertMarkdown(content);
  return {
    html,
    preCleanedContent: { title, summary, author },
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
 * @param content - The raw file bytes
 * @param filename - The original filename (used for type detection and title)
 * @returns The converted content, or throws if the type is unsupported
 */
export async function convertUploadedFile(
  content: Buffer,
  filename: string
): Promise<ConvertedUpload> {
  const fileType = detectFileType(filename);

  if (!fileType) {
    throw new Error(
      `Unsupported file type. Supported types: ${SUPPORTED_UPLOAD_EXTENSIONS.join(", ")}`
    );
  }

  logger.info("Converting uploaded file", { filename, fileType });

  switch (fileType) {
    case "docx":
      return convertDocx(content, filename);

    case "pdf":
      return convertPdf(content, filename);

    case "html":
      // Readability runs downstream. No Content-Type, so the file's own
      // <meta charset> (or BOM) decides its encoding.
      return {
        html: decodeBody(content, null),
        preCleanedContent: null,
        fileType: "html",
        filename,
      };

    case "markdown":
      // Also handles plain text files
      return convertMarkdownFile(content.toString("utf-8"), filename);
  }
}

/**
 * Gets a human-readable description of supported file types.
 */
export function getSupportedTypesDescription(): string {
  return "Word documents (.docx), PDFs (.pdf), HTML files (.html), Markdown files (.md), and text files (.txt)";
}

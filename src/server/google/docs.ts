/**
 * Google Docs content fetcher using the Google Docs API.
 *
 * Google Docs pages don't render well with server-side HTML fetching due to heavy
 * JavaScript dependence. This module provides access to document content via the
 * Google Docs API, converting structured document data to clean HTML.
 *
 * Supported elements:
 * - Paragraphs with text styling (bold, italic, underline, strikethrough, links)
 * - Headings (H1-H6, Title, Subtitle)
 * - Tables with nested content
 * - Footnotes (rendered at the end of the document)
 * - Inline and positioned images (uploaded to object storage if configured)
 * - Horizontal rules
 * - Lists (ordered and unordered with proper nesting)
 *
 * Phase 1: Public documents only (requires service account credentials)
 * Phase 2: Private documents with user OAuth tokens (future)
 *
 * Note: The Google Docs API requires OAuth2 tokens - API keys are not supported.
 * For server-side access to public documents, we use a service account.
 */

import { z } from "zod";
import { GoogleAuth } from "google-auth-library";
import { logger } from "@/lib/logger";
import { googleConfig } from "@/server/config/env";
import { fetchAndUploadImage, isStorageAvailable } from "@/server/storage/s3";

// ============================================================================
// Constants
// ============================================================================

/**
 * Google Docs API v1 endpoint.
 */
const GOOGLE_DOCS_API_ENDPOINT = "https://docs.googleapis.com/v1/documents";

/**
 * Timeout for API requests in milliseconds.
 */
const API_TIMEOUT_MS = 15000;

/**
 * User-Agent for requests.
 */
const USER_AGENT = "LionReader/1.0 (+https://lionreader.com)";

/**
 * OAuth2 scope required for reading Google Docs.
 */
const GOOGLE_DOCS_SCOPE = "https://www.googleapis.com/auth/documents.readonly";

// ============================================================================
// Service Account Authentication
// ============================================================================

/**
 * Cached GoogleAuth client instance.
 * Initialized lazily on first use.
 */
let googleAuthClient: GoogleAuth | null = null;

/**
 * Parses the base64-encoded service account JSON from environment.
 */
function parseServiceAccountCredentials(): Record<string, unknown> | null {
  if (!googleConfig.serviceAccountJson) {
    return null;
  }

  try {
    const decoded = Buffer.from(googleConfig.serviceAccountJson, "base64").toString("utf-8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch (error) {
    logger.error(
      "Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON - ensure it is valid base64-encoded JSON",
      {
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return null;
  }
}

/**
 * Gets or creates the GoogleAuth client for service account authentication.
 */
function getGoogleAuthClient(): GoogleAuth | null {
  if (googleAuthClient) {
    return googleAuthClient;
  }

  const credentials = parseServiceAccountCredentials();
  if (!credentials) {
    return null;
  }

  googleAuthClient = new GoogleAuth({
    credentials,
    scopes: [GOOGLE_DOCS_SCOPE],
  });

  return googleAuthClient;
}

/**
 * Gets an access token for the Google Docs API using service account credentials.
 */
async function getServiceAccountAccessToken(): Promise<string | null> {
  const auth = getGoogleAuthClient();
  if (!auth) {
    return null;
  }

  try {
    const client = await auth.getClient();
    const tokenResponse = await client.getAccessToken();
    return tokenResponse.token ?? null;
  } catch (error) {
    logger.error("Failed to get Google service account access token", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ============================================================================
// URL Parsing
// ============================================================================

/**
 * Pattern for matching Google Docs document URLs.
 * Matches:
 *   https://docs.google.com/document/d/{docId}/edit
 *   https://docs.google.com/document/d/{docId}/
 *   https://docs.google.com/document/d/{docId}/pub
 *   https://docs.google.com/document/d/{docId}/preview
 *
 * Document IDs are alphanumeric with hyphens and underscores.
 */
const GOOGLE_DOCS_URL_PATTERN = /^https?:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/;

/**
 * Checks if a URL is a Google Docs document URL.
 */
export function isGoogleDocsUrl(url: string): boolean {
  return GOOGLE_DOCS_URL_PATTERN.test(url);
}

/**
 * Extracts the document ID from a Google Docs URL.
 * Returns null if the URL is not a valid Google Docs URL.
 */
export function extractDocId(url: string): string | null {
  const match = url.match(GOOGLE_DOCS_URL_PATTERN);
  return match ? match[1] : null;
}

// ============================================================================
// Google Docs API Types (Zod Schemas)
// ============================================================================

/**
 * Link destination from Google Docs API.
 */
const linkSchema = z.object({
  url: z.string().optional(),
  bookmarkId: z.string().optional(),
  headingId: z.string().optional(),
});

/**
 * Text style from Google Docs API.
 */
const textStyleSchema = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  smallCaps: z.boolean().optional(),
  baselineOffset: z.enum(["BASELINE_OFFSET_UNSPECIFIED", "NONE", "SUPERSCRIPT", "SUBSCRIPT"]).optional(),
  link: linkSchema.optional(),
});

/**
 * Text run element from Google Docs API.
 */
const textRunSchema = z.object({
  content: z.string(),
  textStyle: textStyleSchema.optional(),
});

/**
 * Footnote reference element from Google Docs API.
 */
const footnoteReferenceSchema = z.object({
  footnoteId: z.string(),
  footnoteNumber: z.string().optional(),
  textStyle: textStyleSchema.optional(),
});

/**
 * Inline object element from Google Docs API.
 */
const inlineObjectElementSchema = z.object({
  inlineObjectId: z.string(),
  textStyle: textStyleSchema.optional(),
});

/**
 * Horizontal rule element from Google Docs API.
 */
const horizontalRuleSchema = z.object({
  textStyle: textStyleSchema.optional(),
});

/**
 * Rich link element (links to Google resources).
 */
const richLinkSchema = z.object({
  richLinkId: z.string().optional(),
  richLinkProperties: z.object({
    title: z.string().optional(),
    uri: z.string().optional(),
    mimeType: z.string().optional(),
  }).optional(),
  textStyle: textStyleSchema.optional(),
});

/**
 * Person mention element.
 */
const personSchema = z.object({
  personId: z.string().optional(),
  personProperties: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
  }).optional(),
  textStyle: textStyleSchema.optional(),
});

/**
 * Paragraph element from Google Docs API (union of possible element types).
 */
const paragraphElementSchema = z.object({
  startIndex: z.number().optional(),
  endIndex: z.number().optional(),
  textRun: textRunSchema.optional(),
  footnoteReference: footnoteReferenceSchema.optional(),
  inlineObjectElement: inlineObjectElementSchema.optional(),
  horizontalRule: horizontalRuleSchema.optional(),
  richLink: richLinkSchema.optional(),
  person: personSchema.optional(),
  // pageBreak, columnBreak, autoText, equation are ignored for HTML conversion
});

/**
 * Bullet (list item marker) from Google Docs API.
 */
const bulletSchema = z.object({
  listId: z.string(),
  nestingLevel: z.number().optional(),
  textStyle: textStyleSchema.optional(),
});

/**
 * Paragraph style from Google Docs API.
 */
const paragraphStyleSchema = z.object({
  namedStyleType: z.string().optional(),
  headingId: z.string().optional(),
});

/**
 * Paragraph from Google Docs API.
 */
const paragraphSchema = z.object({
  elements: z.array(paragraphElementSchema).optional(),
  paragraphStyle: paragraphStyleSchema.optional(),
  bullet: bulletSchema.optional(),
  positionedObjectIds: z.array(z.string()).optional(),
});

/**
 * Table cell style from Google Docs API.
 */
const tableCellStyleSchema = z.object({
  rowSpan: z.number().optional(),
  columnSpan: z.number().optional(),
}).passthrough();

/**
 * Structural element schema (forward declaration for recursive types).
 * We use z.lazy() for the recursive table cell content.
 */
type StructuralElement = {
  startIndex?: number;
  endIndex?: number;
  paragraph?: z.infer<typeof paragraphSchema>;
  table?: {
    rows: number;
    columns: number;
    tableRows?: Array<{
      startIndex?: number;
      endIndex?: number;
      tableCells?: Array<{
        startIndex?: number;
        endIndex?: number;
        content?: StructuralElement[];
        tableCellStyle?: z.infer<typeof tableCellStyleSchema>;
      }>;
    }>;
  };
  tableOfContents?: {
    content?: StructuralElement[];
  };
  sectionBreak?: unknown;
};

/**
 * Table cell from Google Docs API.
 */
const tableCellSchema: z.ZodType<{
  startIndex?: number;
  endIndex?: number;
  content?: StructuralElement[];
  tableCellStyle?: z.infer<typeof tableCellStyleSchema>;
}> = z.object({
  startIndex: z.number().optional(),
  endIndex: z.number().optional(),
  content: z.lazy(() => z.array(structuralElementSchema)).optional(),
  tableCellStyle: tableCellStyleSchema.optional(),
});

/**
 * Table row from Google Docs API.
 */
const tableRowSchema = z.object({
  startIndex: z.number().optional(),
  endIndex: z.number().optional(),
  tableCells: z.array(tableCellSchema).optional(),
});

/**
 * Table from Google Docs API.
 */
const tableSchema = z.object({
  rows: z.number(),
  columns: z.number(),
  tableRows: z.array(tableRowSchema).optional(),
});

/**
 * Table of contents from Google Docs API.
 */
const tableOfContentsSchema = z.object({
  content: z.lazy(() => z.array(structuralElementSchema)).optional(),
});

/**
 * Structural element from Google Docs API.
 */
const structuralElementSchema: z.ZodType<StructuralElement> = z.object({
  startIndex: z.number().optional(),
  endIndex: z.number().optional(),
  paragraph: paragraphSchema.optional(),
  table: tableSchema.optional(),
  tableOfContents: tableOfContentsSchema.optional(),
  sectionBreak: z.unknown().optional(),
});

/**
 * Document body from Google Docs API.
 */
const documentBodySchema = z.object({
  content: z.array(structuralElementSchema).optional(),
});

/**
 * Footnote content from Google Docs API.
 */
const footnoteSchema = z.object({
  footnoteId: z.string(),
  content: z.array(structuralElementSchema).optional(),
});

/**
 * Image properties from Google Docs API.
 */
const imagePropertiesSchema = z.object({
  contentUri: z.string().optional(),
  sourceUri: z.string().optional(),
});

/**
 * Embedded object (image) from Google Docs API.
 */
const embeddedObjectSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  imageProperties: imagePropertiesSchema.optional(),
});

/**
 * Inline object from Google Docs API.
 */
const inlineObjectSchema = z.object({
  objectId: z.string(),
  inlineObjectProperties: z.object({
    embeddedObject: embeddedObjectSchema.optional(),
  }).optional(),
});

/**
 * Positioned object from Google Docs API.
 */
const positionedObjectSchema = z.object({
  objectId: z.string(),
  positionedObjectProperties: z.object({
    embeddedObject: embeddedObjectSchema.optional(),
  }).optional(),
});

/**
 * List nesting level properties.
 */
const nestingLevelSchema = z.object({
  bulletAlignment: z.string().optional(),
  glyphType: z.string().optional(),
  glyphSymbol: z.string().optional(),
  glyphFormat: z.string().optional(),
  startNumber: z.number().optional(),
});

/**
 * List properties from Google Docs API.
 */
const listPropertiesSchema = z.object({
  nestingLevels: z.array(nestingLevelSchema).optional(),
});

/**
 * List from Google Docs API.
 */
const listSchema = z.object({
  listProperties: listPropertiesSchema.optional(),
});

/**
 * Full document from Google Docs API.
 */
const googleDocsApiResponseSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  body: documentBodySchema,
  footnotes: z.record(z.string(), footnoteSchema).optional(),
  inlineObjects: z.record(z.string(), inlineObjectSchema).optional(),
  positionedObjects: z.record(z.string(), positionedObjectSchema).optional(),
  lists: z.record(z.string(), listSchema).optional(),
});

/**
 * Result from fetching Google Docs content.
 */
export interface GoogleDocsContent {
  /** Document ID */
  docId: string;
  /** Document title */
  title: string;
  /** HTML content converted from document structure */
  html: string;
  /** Author (null for public API, may be available with OAuth) */
  author: string | null;
  /** Creation date (null for public API) */
  createdAt: Date | null;
  /** Last modified date (null for public API) */
  modifiedAt: Date | null;
}

// ============================================================================
// HTML Conversion
// ============================================================================

type ParsedDoc = z.infer<typeof googleDocsApiResponseSchema>;

/**
 * Context for HTML conversion, containing document-level data.
 */
interface ConversionContext {
  doc: ParsedDoc;
  /** Map of image object IDs to their uploaded URLs */
  imageUrls: Map<string, string>;
  /** Footnotes encountered during conversion (id -> number) */
  footnoteNumbers: Map<string, number>;
  /** Current footnote counter */
  footnoteCounter: number;
}

/**
 * Escapes HTML special characters.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Gets the HTML tag for a paragraph based on its style.
 */
function getParagraphTag(namedStyle?: string): { open: string; close: string } {
  switch (namedStyle) {
    case "HEADING_1":
    case "TITLE":
      return { open: "<h1>", close: "</h1>" };
    case "HEADING_2":
    case "SUBTITLE":
      return { open: "<h2>", close: "</h2>" };
    case "HEADING_3":
      return { open: "<h3>", close: "</h3>" };
    case "HEADING_4":
      return { open: "<h4>", close: "</h4>" };
    case "HEADING_5":
      return { open: "<h5>", close: "</h5>" };
    case "HEADING_6":
      return { open: "<h6>", close: "</h6>" };
    default:
      return { open: "<p>", close: "</p>" };
  }
}

/**
 * Determines if a list is ordered based on its glyph type.
 */
function isOrderedList(listId: string, nestingLevel: number, ctx: ConversionContext): boolean {
  const list = ctx.doc.lists?.[listId];
  const level = list?.listProperties?.nestingLevels?.[nestingLevel];
  const glyphType = level?.glyphType;

  // Ordered glyph types
  const orderedTypes = ["DECIMAL", "ZERO_DECIMAL", "UPPER_ALPHA", "ALPHA", "UPPER_ROMAN", "ROMAN"];
  return glyphType ? orderedTypes.includes(glyphType) : false;
}

/**
 * Gets the image URL for an inline or positioned object.
 */
function getImageUrl(objectId: string, ctx: ConversionContext): string | null {
  // Check if we have an uploaded URL
  const uploadedUrl = ctx.imageUrls.get(objectId);
  if (uploadedUrl) {
    return uploadedUrl;
  }

  // Get the original URL from inline objects
  const inlineObj = ctx.doc.inlineObjects?.[objectId];
  if (inlineObj?.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri) {
    return inlineObj.inlineObjectProperties.embeddedObject.imageProperties.contentUri;
  }

  // Get the original URL from positioned objects
  const posObj = ctx.doc.positionedObjects?.[objectId];
  if (posObj?.positionedObjectProperties?.embeddedObject?.imageProperties?.contentUri) {
    return posObj.positionedObjectProperties.embeddedObject.imageProperties.contentUri;
  }

  return null;
}

/**
 * Gets alt text for an image object.
 */
function getImageAlt(objectId: string, ctx: ConversionContext): string {
  const inlineObj = ctx.doc.inlineObjects?.[objectId];
  const posObj = ctx.doc.positionedObjects?.[objectId];
  const obj = inlineObj?.inlineObjectProperties?.embeddedObject ||
              posObj?.positionedObjectProperties?.embeddedObject;

  if (obj?.title) return obj.title;
  if (obj?.description) return obj.description;
  return "Image";
}

/**
 * Converts a text style to HTML tags.
 */
function applyTextStyle(text: string, style?: z.infer<typeof textStyleSchema>): string {
  if (!style) return text;

  let result = text;

  // Apply link first (innermost)
  if (style.link?.url) {
    const escapedUrl = escapeHtml(style.link.url);
    result = `<a href="${escapedUrl}">${result}</a>`;
  }

  // Apply text styles
  if (style.bold) {
    result = `<strong>${result}</strong>`;
  }
  if (style.italic) {
    result = `<em>${result}</em>`;
  }
  if (style.underline && !style.link) {
    // Don't underline links (they're already styled)
    result = `<u>${result}</u>`;
  }
  if (style.strikethrough) {
    result = `<s>${result}</s>`;
  }
  if (style.smallCaps) {
    result = `<span style="font-variant: small-caps">${result}</span>`;
  }
  if (style.baselineOffset === "SUPERSCRIPT") {
    result = `<sup>${result}</sup>`;
  } else if (style.baselineOffset === "SUBSCRIPT") {
    result = `<sub>${result}</sub>`;
  }

  return result;
}

/**
 * Converts paragraph elements to HTML content.
 */
function convertParagraphElements(
  elements: z.infer<typeof paragraphElementSchema>[] | undefined,
  ctx: ConversionContext
): string {
  if (!elements) return "";

  let content = "";

  for (const elem of elements) {
    // Text run
    if (elem.textRun) {
      const escapedText = escapeHtml(elem.textRun.content);
      content += applyTextStyle(escapedText, elem.textRun.textStyle);
    }

    // Footnote reference
    if (elem.footnoteReference) {
      const footnoteId = elem.footnoteReference.footnoteId;
      let footnoteNum = ctx.footnoteNumbers.get(footnoteId);
      if (footnoteNum === undefined) {
        ctx.footnoteCounter++;
        footnoteNum = ctx.footnoteCounter;
        ctx.footnoteNumbers.set(footnoteId, footnoteNum);
      }
      content += `<sup><a href="#footnote-${footnoteNum}" id="footnote-ref-${footnoteNum}">[${footnoteNum}]</a></sup>`;
    }

    // Inline object (image)
    if (elem.inlineObjectElement) {
      const objectId = elem.inlineObjectElement.inlineObjectId;
      const imageUrl = getImageUrl(objectId, ctx);
      if (imageUrl) {
        const alt = escapeHtml(getImageAlt(objectId, ctx));
        content += `<img src="${escapeHtml(imageUrl)}" alt="${alt}" loading="lazy">`;
      }
    }

    // Horizontal rule
    if (elem.horizontalRule) {
      content += "<hr>";
    }

    // Rich link (Google resource link)
    if (elem.richLink?.richLinkProperties?.uri) {
      const uri = elem.richLink.richLinkProperties.uri;
      const title = elem.richLink.richLinkProperties.title || uri;
      const url = escapeHtml(uri);
      content += `<a href="${url}">${escapeHtml(title)}</a>`;
    }

    // Person mention
    if (elem.person?.personProperties) {
      const props = elem.person.personProperties;
      const displayName = props.name || props.email || "Unknown";
      if (props.email) {
        content += `<a href="mailto:${escapeHtml(props.email)}">${escapeHtml(displayName)}</a>`;
      } else {
        content += escapeHtml(displayName);
      }
    }
  }

  return content;
}

/**
 * Converts a table to HTML.
 */
function convertTable(table: NonNullable<StructuralElement["table"]>, ctx: ConversionContext): string {
  if (!table.tableRows) {
    return "";
  }

  const rows: string[] = [];

  for (const row of table.tableRows) {
    if (!row.tableCells) continue;

    const cells: string[] = [];
    for (const cell of row.tableCells) {
      // Convert cell content (may contain nested structural elements)
      const cellContent = cell.content
        ? convertStructuralElements(cell.content, ctx)
        : "";

      // Handle rowspan and colspan
      const style = cell.tableCellStyle;
      let attrs = "";
      if (style?.rowSpan && style.rowSpan > 1) {
        attrs += ` rowspan="${style.rowSpan}"`;
      }
      if (style?.columnSpan && style.columnSpan > 1) {
        attrs += ` colspan="${style.columnSpan}"`;
      }

      cells.push(`<td${attrs}>${cellContent}</td>`);
    }

    rows.push(`<tr>${cells.join("")}</tr>`);
  }

  return `<table>\n${rows.join("\n")}\n</table>`;
}

/**
 * Tracks list state for proper nesting.
 */
interface ListState {
  listId: string;
  nestingLevel: number;
  isOrdered: boolean;
}

/**
 * Converts structural elements to HTML, handling lists properly.
 */
function convertStructuralElements(
  elements: StructuralElement[],
  ctx: ConversionContext
): string {
  const htmlParts: string[] = [];
  const listStack: ListState[] = [];

  for (const element of elements) {
    // Handle table
    if (element.table) {
      // Close any open lists
      while (listStack.length > 0) {
        const state = listStack.pop()!;
        htmlParts.push(state.isOrdered ? "</ol>" : "</ul>");
      }
      htmlParts.push(convertTable(element.table, ctx));
      continue;
    }

    // Handle table of contents (render as nested structure)
    if (element.tableOfContents?.content) {
      while (listStack.length > 0) {
        const state = listStack.pop()!;
        htmlParts.push(state.isOrdered ? "</ol>" : "</ul>");
      }
      htmlParts.push('<nav class="table-of-contents">');
      htmlParts.push(convertStructuralElements(element.tableOfContents.content, ctx));
      htmlParts.push("</nav>");
      continue;
    }

    // Handle paragraph
    if (element.paragraph) {
      const paragraph = element.paragraph;
      const bullet = paragraph.bullet;
      const namedStyle = paragraph.paragraphStyle?.namedStyleType;

      // Check for positioned objects attached to this paragraph
      const positionedImages: string[] = [];
      if (paragraph.positionedObjectIds) {
        for (const objectId of paragraph.positionedObjectIds) {
          const imageUrl = getImageUrl(objectId, ctx);
          if (imageUrl) {
            const alt = escapeHtml(getImageAlt(objectId, ctx));
            positionedImages.push(
              `<figure><img src="${escapeHtml(imageUrl)}" alt="${alt}" loading="lazy"></figure>`
            );
          }
        }
      }

      // Convert paragraph content
      const content = convertParagraphElements(paragraph.elements, ctx);

      // Handle list items
      if (bullet) {
        const listId = bullet.listId;
        const nestingLevel = bullet.nestingLevel ?? 0;
        const isOrdered = isOrderedList(listId, nestingLevel, ctx);

        // Close lists that are no longer active or at higher nesting levels
        while (
          listStack.length > 0 &&
          (listStack[listStack.length - 1].listId !== listId ||
           listStack[listStack.length - 1].nestingLevel > nestingLevel)
        ) {
          const state = listStack.pop()!;
          htmlParts.push(state.isOrdered ? "</ol>" : "</ul>");
        }

        // Open new lists as needed
        while (
          listStack.length === 0 ||
          listStack[listStack.length - 1].nestingLevel < nestingLevel
        ) {
          const currentLevel = listStack.length === 0 ? 0 : listStack[listStack.length - 1].nestingLevel + 1;
          const newIsOrdered = isOrderedList(listId, currentLevel, ctx);
          listStack.push({ listId, nestingLevel: currentLevel, isOrdered: newIsOrdered });
          htmlParts.push(newIsOrdered ? "<ol>" : "<ul>");
        }

        // Add the list item
        if (content.trim() || positionedImages.length > 0) {
          htmlParts.push(`<li>${positionedImages.join("")}${content}</li>`);
        }
      } else {
        // Close all open lists before non-list content
        while (listStack.length > 0) {
          const state = listStack.pop()!;
          htmlParts.push(state.isOrdered ? "</ol>" : "</ul>");
        }

        // Add positioned images before the paragraph
        htmlParts.push(...positionedImages);

        // Add the paragraph if it has content
        if (content.trim()) {
          const { open, close } = getParagraphTag(namedStyle);
          htmlParts.push(`${open}${content}${close}`);
        }
      }
    }
  }

  // Close any remaining open lists
  while (listStack.length > 0) {
    const state = listStack.pop()!;
    htmlParts.push(state.isOrdered ? "</ol>" : "</ul>");
  }

  return htmlParts.join("\n");
}

/**
 * Converts footnotes to HTML.
 */
function convertFootnotes(ctx: ConversionContext): string {
  if (ctx.footnoteNumbers.size === 0) {
    return "";
  }

  const footnoteHtml: string[] = ['<section class="footnotes"><hr><ol>'];

  // Sort footnotes by their number
  const sortedFootnotes = Array.from(ctx.footnoteNumbers.entries())
    .sort((a, b) => a[1] - b[1]);

  for (const [footnoteId, footnoteNum] of sortedFootnotes) {
    const footnote = ctx.doc.footnotes?.[footnoteId];
    if (footnote?.content) {
      const content = convertStructuralElements(footnote.content, ctx);
      footnoteHtml.push(
        `<li id="footnote-${footnoteNum}">${content} <a href="#footnote-ref-${footnoteNum}">↩</a></li>`
      );
    }
  }

  footnoteHtml.push("</ol></section>");
  return footnoteHtml.join("\n");
}

/**
 * Extracts and uploads images from the document.
 *
 * @param doc - The parsed Google Docs document
 * @param docId - The document ID (used for organizing images)
 * @param accessToken - The OAuth access token for fetching images
 * @returns Map of object IDs to uploaded URLs
 */
async function uploadDocumentImages(
  doc: ParsedDoc,
  docId: string,
  accessToken: string
): Promise<Map<string, string>> {
  const imageUrls = new Map<string, string>();

  if (!isStorageAvailable()) {
    logger.debug("Storage not configured, images will use original URLs");
    return imageUrls;
  }

  // Collect all image objects
  const imageObjects: Array<{ objectId: string; contentUri: string; alt: string }> = [];

  // Inline objects
  if (doc.inlineObjects) {
    for (const [objectId, obj] of Object.entries(doc.inlineObjects)) {
      const contentUri = obj.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri;
      if (contentUri) {
        const alt = obj.inlineObjectProperties?.embeddedObject?.title ||
                   obj.inlineObjectProperties?.embeddedObject?.description || "Image";
        imageObjects.push({ objectId, contentUri, alt });
      }
    }
  }

  // Positioned objects
  if (doc.positionedObjects) {
    for (const [objectId, obj] of Object.entries(doc.positionedObjects)) {
      const contentUri = obj.positionedObjectProperties?.embeddedObject?.imageProperties?.contentUri;
      if (contentUri) {
        const alt = obj.positionedObjectProperties?.embeddedObject?.title ||
                   obj.positionedObjectProperties?.embeddedObject?.description || "Image";
        imageObjects.push({ objectId, contentUri, alt });
      }
    }
  }

  if (imageObjects.length === 0) {
    return imageUrls;
  }

  logger.debug("Uploading document images", {
    docId,
    imageCount: imageObjects.length,
  });

  // Upload images in parallel (with concurrency limit)
  const CONCURRENCY = 5;
  for (let i = 0; i < imageObjects.length; i += CONCURRENCY) {
    const batch = imageObjects.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ({ objectId, contentUri }) => {
        try {
          const result = await fetchAndUploadImage(contentUri, {
            documentId: docId,
            prefix: "google-docs",
            authorization: `Bearer ${accessToken}`,
          });
          if (result) {
            return { objectId, url: result.url };
          }
        } catch (error) {
          logger.warn("Failed to upload image", {
            objectId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return null;
      })
    );

    for (const result of results) {
      if (result) {
        imageUrls.set(result.objectId, result.url);
      }
    }
  }

  logger.debug("Image upload complete", {
    docId,
    uploaded: imageUrls.size,
    total: imageObjects.length,
  });

  return imageUrls;
}

/**
 * Converts Google Docs API structured content to HTML.
 *
 * Handles:
 * - Paragraphs with text styling (bold, italic, underline, strikethrough)
 * - Headings (H1-H6, Title, Subtitle)
 * - Tables with nested content
 * - Footnotes (rendered at the end)
 * - Inline and positioned images
 * - Horizontal rules
 * - Ordered and unordered lists with proper nesting
 * - Rich links and person mentions
 * - Superscript and subscript text
 */
async function convertDocsApiToHtml(
  doc: ParsedDoc,
  accessToken: string
): Promise<string> {
  if (!doc.body.content) {
    return "<p>Empty document</p>";
  }

  // Upload images to storage (if configured)
  const imageUrls = await uploadDocumentImages(doc, doc.documentId, accessToken);

  // Create conversion context
  const ctx: ConversionContext = {
    doc,
    imageUrls,
    footnoteNumbers: new Map(),
    footnoteCounter: 0,
  };

  // Convert body content
  const bodyHtml = convertStructuralElements(doc.body.content, ctx);

  // Convert footnotes
  const footnotesHtml = convertFootnotes(ctx);

  return bodyHtml + (footnotesHtml ? "\n" + footnotesHtml : "");
}

// ============================================================================
// Public Document Fetching
// ============================================================================

/**
 * Checks if the Google Docs API is available (service account configured).
 */
export function isGoogleDocsApiAvailable(): boolean {
  return !!googleConfig.serviceAccountJson;
}

/**
 * Fetches a public Google Doc using the Google Docs API with service account credentials.
 *
 * Requires GOOGLE_SERVICE_ACCOUNT_JSON to be configured. The service account
 * authenticates the request and can access publicly shared documents.
 *
 * For private documents, use fetchPrivateGoogleDoc with a user's OAuth
 * access token (Phase 2).
 *
 * @param docId - The Google Docs document ID
 * @returns Document content including HTML, or null if fetch fails or doc is private
 */
export async function fetchPublicGoogleDoc(docId: string): Promise<GoogleDocsContent | null> {
  // Check if service account is configured
  if (!googleConfig.serviceAccountJson) {
    logger.debug("Google service account not configured, skipping API fetch", { docId });
    return null;
  }

  // Get access token from service account
  const accessToken = await getServiceAccountAccessToken();
  if (!accessToken) {
    logger.warn("Failed to get service account access token, skipping API fetch", { docId });
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const url = `${GOOGLE_DOCS_API_ENDPOINT}/${docId}`;

    logger.debug("Fetching public Google Doc", { docId });

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      // Try to get error details from response body
      let errorDetails: string | undefined;
      try {
        const errorJson = await response.json();
        errorDetails = errorJson?.error?.message;
      } catch {
        // Ignore JSON parse errors
      }

      if (response.status === 401) {
        // 401 means token issue
        logger.warn(
          "Google Docs API authentication failed - service account token may be invalid",
          {
            docId,
            status: response.status,
            errorDetails,
          }
        );
      } else if (response.status === 403) {
        logger.debug("Google Doc is private or not accessible to service account", {
          docId,
          status: response.status,
          errorDetails,
        });
      } else if (response.status === 404) {
        logger.debug("Google Doc not found", { docId });
      } else {
        logger.warn("Google Docs API request failed", {
          docId,
          status: response.status,
          statusText: response.statusText,
          errorDetails,
        });
      }
      return null;
    }

    const json = await response.json();
    const parsed = googleDocsApiResponseSchema.safeParse(json);

    if (!parsed.success) {
      logger.warn("Google Docs API response validation failed", {
        docId,
        error: parsed.error.message,
      });
      return null;
    }

    const doc = parsed.data;

    // Convert structured document to HTML (includes image upload if storage is configured)
    const html = await convertDocsApiToHtml(doc, accessToken);

    return {
      docId: doc.documentId,
      title: doc.title,
      html,
      author: null, // Not available via service account
      createdAt: null, // Not available via service account
      modifiedAt: null, // Not available via service account
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn("Google Docs API request timed out", { docId });
    } else {
      logger.warn("Google Docs API request error", {
        docId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetches Google Docs content from a URL.
 *
 * This is a convenience function that extracts the document ID from the URL
 * and fetches the content using the public API.
 *
 * Phase 1: Only supports public documents
 * Phase 2: Will support private documents with user OAuth tokens
 *
 * @param url - The Google Docs document URL
 * @returns Document content including HTML, or null if URL is invalid or fetch fails
 */
export async function fetchGoogleDocsFromUrl(url: string): Promise<GoogleDocsContent | null> {
  const docId = extractDocId(url);
  if (!docId) {
    logger.debug("Not a valid Google Docs URL", { url });
    return null;
  }

  return fetchPublicGoogleDoc(docId);
}

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
import { USER_AGENT } from "@/server/http/user-agent";
import { escapeHtml } from "@/server/http/html";
import {
  fetchPublicDocxFile,
  fetchPrivateDocxFile,
  GOOGLE_DRIVE_SCOPE,
  type GoogleDriveContent,
} from "./drive";

// Re-export the Drive scope for use in saved.ts (needed for OAuth)
export { GOOGLE_DRIVE_SCOPE };

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

/**
 * Extracts the tab ID from a Google Docs URL query string.
 * Tab IDs are in the format: ?tab=t.{tabId}
 * Returns the full tab parameter value (e.g., "t.0") to match the API's tabId format.
 * Returns null if no tab is specified.
 */
export function extractTabId(url: string): string | null {
  try {
    const urlObj = new URL(url);
    // Return the full tab parameter value - the API's tabProperties.tabId uses the same format
    return urlObj.searchParams.get("tab");
  } catch {
    return null;
  }
}

/**
 * Normalizes a Google Docs URL by removing all query parameters except 'tab'.
 * This creates a canonical URL for the document, since other query parameters
 * (like usp=sharing, pli, etc.) don't identify unique content.
 *
 * @param url - The Google Docs URL to normalize
 * @returns The normalized URL with only essential query parameters
 */
export function normalizeGoogleDocsUrl(url: string): string {
  try {
    const urlObj = new URL(url);

    // Get the tab parameter before clearing
    const tabParam = urlObj.searchParams.get("tab");

    // Clear all query parameters
    urlObj.search = "";

    // Re-add only the tab parameter if it exists
    if (tabParam) {
      urlObj.searchParams.set("tab", tabParam);
    }

    return urlObj.href;
  } catch {
    // Return original URL if parsing fails
    return url;
  }
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
  baselineOffset: z
    .enum(["BASELINE_OFFSET_UNSPECIFIED", "NONE", "SUPERSCRIPT", "SUBSCRIPT"])
    .optional(),
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
  richLinkProperties: z
    .object({
      title: z.string().optional(),
      uri: z.string().optional(),
      mimeType: z.string().optional(),
    })
    .optional(),
  textStyle: textStyleSchema.optional(),
});

/**
 * Person mention element.
 */
const personSchema = z.object({
  personId: z.string().optional(),
  personProperties: z
    .object({
      name: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
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
const tableCellStyleSchema = z
  .object({
    rowSpan: z.number().optional(),
    columnSpan: z.number().optional(),
  })
  .passthrough();

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
  inlineObjectProperties: z
    .object({
      embeddedObject: embeddedObjectSchema.optional(),
    })
    .optional(),
});

/**
 * Positioned object from Google Docs API.
 */
const positionedObjectSchema = z.object({
  objectId: z.string(),
  positionedObjectProperties: z
    .object({
      embeddedObject: embeddedObjectSchema.optional(),
    })
    .optional(),
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
 * Tab properties from Google Docs API.
 */
const tabPropertiesSchema = z.object({
  tabId: z.string(),
  title: z.string().optional(),
  parentTabId: z.string().optional(),
  index: z.number().optional(),
  nestingLevel: z.number().optional(),
});

/**
 * Document tab content from Google Docs API.
 * Contains the actual content when includeTabsContent=true.
 */
const documentTabSchema = z.object({
  body: documentBodySchema.optional(),
  footnotes: z.record(z.string(), footnoteSchema).optional(),
  inlineObjects: z.record(z.string(), inlineObjectSchema).optional(),
  positionedObjects: z.record(z.string(), positionedObjectSchema).optional(),
  lists: z.record(z.string(), listSchema).optional(),
});

/**
 * Tab from Google Docs API.
 * Tabs can contain child tabs (nested tabs).
 */
type Tab = {
  tabProperties?: z.infer<typeof tabPropertiesSchema>;
  documentTab?: z.infer<typeof documentTabSchema>;
  childTabs?: Tab[];
};

const tabSchema: z.ZodType<Tab> = z.object({
  tabProperties: tabPropertiesSchema.optional(),
  documentTab: documentTabSchema.optional(),
  childTabs: z.lazy(() => z.array(tabSchema)).optional(),
});

/**
 * Full document from Google Docs API.
 *
 * Note: When using includeTabsContent=true, the legacy fields (body, footnotes, etc.)
 * are NOT populated at the root level - they only exist inside tabs[].documentTab.
 * This is why body is optional here.
 */
const googleDocsApiResponseSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  // Legacy fields (used when includeTabsContent=false or for single-tab docs)
  // Note: These are NOT present when includeTabsContent=true
  body: documentBodySchema.optional(),
  footnotes: z.record(z.string(), footnoteSchema).optional(),
  inlineObjects: z.record(z.string(), inlineObjectSchema).optional(),
  positionedObjects: z.record(z.string(), positionedObjectSchema).optional(),
  lists: z.record(z.string(), listSchema).optional(),
  // Tabs (used when includeTabsContent=true)
  tabs: z.array(tabSchema).optional(),
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

/**
 * Converts Drive API content to Docs API content format for consistency.
 * Used when falling back to Drive API for .docx files.
 */
function driveContentToDocsContent(content: GoogleDriveContent): GoogleDocsContent {
  return {
    docId: content.fileId,
    title: content.title,
    html: content.html,
    author: null,
    createdAt: null,
    modifiedAt: null,
  };
}

// ============================================================================
// Tab Helpers
// ============================================================================

type ParsedDoc = z.infer<typeof googleDocsApiResponseSchema>;

/**
 * Recursively finds a tab by its ID within a list of tabs (including child tabs).
 */
function findTabById(tabs: Tab[] | undefined, tabId: string): Tab | null {
  if (!tabs) return null;

  for (const tab of tabs) {
    if (tab.tabProperties?.tabId === tabId) {
      return tab;
    }
    // Search child tabs recursively
    if (tab.childTabs) {
      const found = findTabById(tab.childTabs, tabId);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Gets the first tab from a document (depth-first traversal).
 */
function getFirstTab(tabs: Tab[] | undefined): Tab | null {
  if (!tabs || tabs.length === 0) return null;
  return tabs[0];
}

/**
 * Represents the content extracted from a specific tab or the document body.
 */
interface TabContent {
  body: z.infer<typeof documentBodySchema>;
  footnotes?: Record<string, z.infer<typeof footnoteSchema>>;
  inlineObjects?: Record<string, z.infer<typeof inlineObjectSchema>>;
  positionedObjects?: Record<string, z.infer<typeof positionedObjectSchema>>;
  lists?: Record<string, z.infer<typeof listSchema>>;
  tabTitle?: string;
}

/**
 * Extracts content from a document, optionally selecting a specific tab.
 *
 * @param doc - The parsed document
 * @param tabId - Optional tab ID to select. If null, uses the first tab or legacy body.
 * @returns The tab content, or null if no content could be found.
 */
function extractTabContent(doc: ParsedDoc, tabId: string | null): TabContent | null {
  // If tabs are available, get content from the appropriate tab
  if (doc.tabs && doc.tabs.length > 0) {
    let tab: Tab | null = null;

    if (tabId) {
      tab = findTabById(doc.tabs, tabId);
      if (!tab) {
        logger.warn("Specified tab not found in document", { tabId });
        // Fall through to use first tab
      }
    }

    // Use the specified tab or fall back to first tab
    if (!tab) {
      tab = getFirstTab(doc.tabs);
    }

    if (tab?.documentTab?.body) {
      return {
        body: tab.documentTab.body,
        footnotes: tab.documentTab.footnotes,
        inlineObjects: tab.documentTab.inlineObjects,
        positionedObjects: tab.documentTab.positionedObjects,
        lists: tab.documentTab.lists,
        tabTitle: tab.tabProperties?.title,
      };
    }
  }

  // Fall back to legacy body fields (for single-tab docs or when includeTabsContent=false)
  // When includeTabsContent=true, doc.body is undefined - we should have found content in tabs above
  if (!doc.body) {
    logger.warn("No document body found in tabs or legacy fields");
    return null;
  }

  return {
    body: doc.body,
    footnotes: doc.footnotes,
    inlineObjects: doc.inlineObjects,
    positionedObjects: doc.positionedObjects,
    lists: doc.lists,
  };
}

// ============================================================================
// HTML Conversion
// ============================================================================

/**
 * Context for HTML conversion, containing document-level data.
 */
interface ConversionContext {
  /** The tab content being converted */
  content: TabContent;
  /** Map of image object IDs to their uploaded URLs */
  imageUrls: Map<string, string>;
  /** Footnotes encountered during conversion (id -> number) */
  footnoteNumbers: Map<string, number>;
  /** Current footnote counter */
  footnoteCounter: number;
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
  const list = ctx.content.lists?.[listId];
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
  const inlineObj = ctx.content.inlineObjects?.[objectId];
  if (inlineObj?.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri) {
    return inlineObj.inlineObjectProperties.embeddedObject.imageProperties.contentUri;
  }

  // Get the original URL from positioned objects
  const posObj = ctx.content.positionedObjects?.[objectId];
  if (posObj?.positionedObjectProperties?.embeddedObject?.imageProperties?.contentUri) {
    return posObj.positionedObjectProperties.embeddedObject.imageProperties.contentUri;
  }

  return null;
}

/**
 * Gets alt text for an image object.
 */
function getImageAlt(objectId: string, ctx: ConversionContext): string {
  const inlineObj = ctx.content.inlineObjects?.[objectId];
  const posObj = ctx.content.positionedObjects?.[objectId];
  const obj =
    inlineObj?.inlineObjectProperties?.embeddedObject ||
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
function convertTable(
  table: NonNullable<StructuralElement["table"]>,
  ctx: ConversionContext
): string {
  if (!table.tableRows) {
    return "";
  }

  const rows: string[] = [];

  for (const row of table.tableRows) {
    if (!row.tableCells) continue;

    const cells: string[] = [];
    for (const cell of row.tableCells) {
      // Convert cell content (may contain nested structural elements)
      const cellContent = cell.content ? convertStructuralElements(cell.content, ctx) : "";

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
function convertStructuralElements(elements: StructuralElement[], ctx: ConversionContext): string {
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
          const currentLevel =
            listStack.length === 0 ? 0 : listStack[listStack.length - 1].nestingLevel + 1;
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
  const sortedFootnotes = Array.from(ctx.footnoteNumbers.entries()).sort((a, b) => a[1] - b[1]);

  for (const [footnoteId, footnoteNum] of sortedFootnotes) {
    const footnote = ctx.content.footnotes?.[footnoteId];
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
 * Extracts and uploads images from the tab content.
 *
 * @param content - The tab content containing image objects
 * @param docId - The document ID (used for organizing images)
 * @param accessToken - The OAuth access token for fetching images
 * @returns Map of object IDs to uploaded URLs
 */
async function uploadDocumentImages(
  content: TabContent,
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
  if (content.inlineObjects) {
    for (const [objectId, obj] of Object.entries(content.inlineObjects)) {
      const contentUri = obj.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri;
      if (contentUri) {
        const alt =
          obj.inlineObjectProperties?.embeddedObject?.title ||
          obj.inlineObjectProperties?.embeddedObject?.description ||
          "Image";
        imageObjects.push({ objectId, contentUri, alt });
      }
    }
  }

  // Positioned objects
  if (content.positionedObjects) {
    for (const [objectId, obj] of Object.entries(content.positionedObjects)) {
      const contentUri =
        obj.positionedObjectProperties?.embeddedObject?.imageProperties?.contentUri;
      if (contentUri) {
        const alt =
          obj.positionedObjectProperties?.embeddedObject?.title ||
          obj.positionedObjectProperties?.embeddedObject?.description ||
          "Image";
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
 * Normalizes text for comparison by removing extra whitespace and trimming.
 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Strips the first header element if its text content matches the document title.
 *
 * Google Docs often includes the document title as the first heading in the body,
 * but since we already have the title from document metadata, showing it twice
 * is redundant. This function removes the first header if it matches the title.
 *
 * @param html - The HTML content
 * @param title - The document title to compare against
 * @returns HTML with the title header removed if it matched
 */
function stripTitleHeader(html: string, title: string): string {
  // Match the first header element (h1-h6) at the start of the content
  // Allows for leading whitespace/newlines
  const headerRegex = /^(\s*)<(h[1-6])>([\s\S]*?)<\/\2>/i;
  const match = html.match(headerRegex);

  if (!match) {
    return html;
  }

  const [fullMatch, , , headerContent] = match;

  // Extract text content from the header (strip any nested HTML tags)
  const headerText = headerContent.replace(/<[^>]+>/g, "");

  // Compare normalized versions of the title and header text
  if (normalizeText(headerText) === normalizeText(title)) {
    // Remove the header and any immediately following newlines
    return html.slice(fullMatch.length).replace(/^\n+/, "");
  }

  return html;
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
 * - Multi-tab documents (select specific tab via tabId)
 *
 * @param doc - The parsed Google Docs document
 * @param accessToken - OAuth access token for fetching images
 * @param tabId - Optional tab ID to select (from URL ?tab=t.{tabId})
 */
async function convertDocsApiToHtml(
  doc: ParsedDoc,
  accessToken: string,
  tabId: string | null = null
): Promise<string> {
  // Extract content from the specified tab (or first tab / legacy body)
  const content = extractTabContent(doc, tabId);
  if (!content || !content.body.content) {
    return "<p>Empty document</p>";
  }

  // Upload images to storage (if configured)
  const imageUrls = await uploadDocumentImages(content, doc.documentId, accessToken);

  // Create conversion context
  const ctx: ConversionContext = {
    content,
    imageUrls,
    footnoteNumbers: new Map(),
    footnoteCounter: 0,
  };

  // Convert body content
  let bodyHtml = convertStructuralElements(content.body.content, ctx);

  // Strip the first header if it matches the document title
  // Google Docs often has the document title as the first heading, but we already
  // have the title from the document metadata, so showing it twice is redundant
  bodyHtml = stripTitleHeader(bodyHtml, doc.title);

  // Convert footnotes
  const footnotesHtml = convertFootnotes(ctx);

  return bodyHtml + (footnotesHtml ? "\n" + footnotesHtml : "");
}

// ============================================================================
// Public Document Fetching
// ============================================================================

/**
 * Fetches a public Google Doc using the Google Docs API with service account credentials.
 *
 * Requires GOOGLE_SERVICE_ACCOUNT_JSON to be configured. The service account
 * authenticates the request and can access publicly shared documents.
 *
 * For uploaded .docx files, falls back to the Drive API with mammoth conversion.
 *
 * For private documents, use fetchPrivateGoogleDoc with a user's OAuth
 * access token (Phase 2).
 *
 * @param docId - The Google Docs document ID
 * @param tabId - Optional tab ID to fetch (from URL ?tab=t.{tabId})
 * @returns Document content including HTML, or null if fetch fails or doc is private
 */
async function fetchPublicGoogleDoc(
  docId: string,
  tabId: string | null = null
): Promise<GoogleDocsContent | null> {
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

  // Track if we should try Drive API fallback
  let shouldTryDriveFallback = false;

  try {
    // Request with includeTabsContent=true to get full tab data
    const url = `${GOOGLE_DOCS_API_ENDPOINT}/${docId}?includeTabsContent=true`;

    logger.debug("Fetching public Google Doc via Docs API", { docId, tabId });

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
        // 401 means token issue - don't retry with Drive API
        logger.warn(
          "Google Docs API authentication failed - service account token may be invalid",
          {
            docId,
            status: response.status,
            errorDetails,
          }
        );
        return null;
      } else if (response.status === 403) {
        // 403 could be private doc or .docx file - try Drive API
        logger.debug("Google Doc not accessible via Docs API, trying Drive API fallback", {
          docId,
          status: response.status,
          errorDetails,
        });
        shouldTryDriveFallback = true;
      } else if (response.status === 404) {
        // 404 could be .docx file which Docs API doesn't recognize - try Drive API
        logger.debug("Google Doc not found via Docs API, trying Drive API fallback", { docId });
        shouldTryDriveFallback = true;
      } else {
        // Other errors - try Drive API as fallback
        logger.debug("Google Docs API request failed, trying Drive API fallback", {
          docId,
          status: response.status,
          statusText: response.statusText,
          errorDetails,
        });
        shouldTryDriveFallback = true;
      }
    } else {
      // Docs API succeeded
      const json = await response.json();
      const parsed = googleDocsApiResponseSchema.safeParse(json);

      if (!parsed.success) {
        logger.warn("Google Docs API response validation failed, trying Drive API fallback", {
          docId,
          error: parsed.error.message,
        });
        shouldTryDriveFallback = true;
      } else {
        const doc = parsed.data;

        // Convert structured document to HTML (includes image upload if storage is configured)
        const html = await convertDocsApiToHtml(doc, accessToken, tabId);

        return {
          docId: doc.documentId,
          title: doc.title,
          html,
          author: null, // Not available via service account
          createdAt: null, // Not available via service account
          modifiedAt: null, // Not available via service account
        };
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn("Google Docs API request timed out, trying Drive API fallback", { docId });
      shouldTryDriveFallback = true;
    } else {
      logger.warn("Google Docs API request error, trying Drive API fallback", {
        docId,
        error: error instanceof Error ? error.message : String(error),
      });
      shouldTryDriveFallback = true;
    }
  } finally {
    clearTimeout(timeout);
  }

  // Try Drive API fallback for .docx files
  if (shouldTryDriveFallback) {
    logger.debug("Attempting Drive API fallback for potential .docx file", { docId });
    const driveContent = await fetchPublicDocxFile(docId);
    if (driveContent) {
      logger.debug("Successfully fetched content via Drive API", { docId });
      return driveContentToDocsContent(driveContent);
    }
    logger.debug("Drive API fallback also failed", { docId });
  }

  return null;
}

/**
 * Fetches a private Google Doc using a user's OAuth access token.
 *
 * Used for Phase 2 of Google Docs integration to access documents that
 * the user has permission to read but aren't publicly shared.
 *
 * For uploaded .docx files, falls back to the Drive API with mammoth conversion.
 *
 * Requires the user to have granted the 'documents.readonly' scope (for native docs)
 * or 'drive.readonly' scope (for .docx files).
 *
 * @param docId - The Google Docs document ID
 * @param accessToken - User's OAuth access token
 * @param tabId - Optional tab ID to fetch (from URL ?tab=t.{tabId})
 * @returns Document content including HTML, or null if fetch fails
 * @throws Error if token is invalid or user doesn't have permission
 */
export async function fetchPrivateGoogleDoc(
  docId: string,
  accessToken: string,
  tabId: string | null = null
): Promise<GoogleDocsContent | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  // Track if we should try Drive API fallback and why
  let shouldTryDriveFallback = false;
  let docsApiError: Error | null = null;

  try {
    // Request with includeTabsContent=true to get full tab data
    const url = `${GOOGLE_DOCS_API_ENDPOINT}/${docId}?includeTabsContent=true`;

    logger.debug("Fetching private Google Doc via Docs API", { docId, tabId });

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
        logger.warn("Google Docs API authentication failed - token may be invalid or expired", {
          docId,
          status: response.status,
          errorDetails,
        });
        throw new Error("GOOGLE_TOKEN_INVALID");
      } else if (response.status === 403) {
        // 403 could be permission denied OR a .docx file - try Drive API first
        logger.debug("Docs API returned 403, trying Drive API fallback", {
          docId,
          status: response.status,
          errorDetails,
        });
        shouldTryDriveFallback = true;
        docsApiError = new Error("GOOGLE_PERMISSION_DENIED");
      } else if (response.status === 404) {
        // 404 could be .docx file which Docs API doesn't recognize - try Drive API
        logger.debug("Google Doc not found via Docs API, trying Drive API fallback", { docId });
        shouldTryDriveFallback = true;
      } else {
        // Other errors - try Drive API as fallback
        logger.debug("Google Docs API request failed, trying Drive API fallback", {
          docId,
          status: response.status,
          statusText: response.statusText,
          errorDetails,
        });
        shouldTryDriveFallback = true;
      }
    } else {
      // Docs API succeeded
      const json = await response.json();
      const parsed = googleDocsApiResponseSchema.safeParse(json);

      if (!parsed.success) {
        logger.warn("Google Docs API response validation failed, trying Drive API fallback", {
          docId,
          error: parsed.error.message,
        });
        shouldTryDriveFallback = true;
      } else {
        const doc = parsed.data;

        // Convert structured document to HTML (includes image upload if storage is configured)
        const html = await convertDocsApiToHtml(doc, accessToken, tabId);

        return {
          docId: doc.documentId,
          title: doc.title,
          html,
          author: null, // Could potentially get this from Drive API metadata
          createdAt: null, // Could potentially get this from Drive API metadata
          modifiedAt: null, // Could potentially get this from Drive API metadata
        };
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn("Google Docs API request timed out, trying Drive API fallback", { docId });
      shouldTryDriveFallback = true;
    } else if (error instanceof Error && error.message === "GOOGLE_TOKEN_INVALID") {
      // Don't retry auth errors
      throw error;
    } else {
      logger.warn("Google Docs API request error, trying Drive API fallback", {
        docId,
        error: error instanceof Error ? error.message : String(error),
      });
      shouldTryDriveFallback = true;
    }
  } finally {
    clearTimeout(timeout);
  }

  // Try Drive API fallback for .docx files
  if (shouldTryDriveFallback) {
    logger.debug("Attempting Drive API fallback for potential .docx file", { docId });
    const driveContent = await fetchPrivateDocxFile(docId, accessToken);
    if (driveContent) {
      logger.debug("Successfully fetched content via Drive API", { docId });
      return driveContentToDocsContent(driveContent);
    }
    logger.debug("Drive API fallback also failed", { docId });

    // If we had a specific error from the Docs API (like permission denied),
    // and Drive API also failed, throw the original error
    if (docsApiError) {
      throw docsApiError;
    }
  }

  return null;
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

  // Extract tab ID if present in URL (e.g., ?tab=t.i957b74dlfgd)
  const tabId = extractTabId(url);

  return fetchPublicGoogleDoc(docId, tabId);
}

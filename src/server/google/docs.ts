/**
 * Google Docs content fetcher using the Google Docs API.
 *
 * Google Docs pages don't render well with server-side HTML fetching due to heavy
 * JavaScript dependence. This module provides access to document content via the
 * Google Docs API, converting structured document data to clean HTML.
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
// Google Docs API Types
// ============================================================================

/**
 * Text style from Google Docs API.
 */
const textStyleSchema = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  link: z
    .object({
      url: z.string(),
    })
    .optional(),
});

/**
 * Text run element from Google Docs API.
 */
const textRunSchema = z.object({
  content: z.string(),
  textStyle: textStyleSchema.optional(),
});

/**
 * Paragraph element from Google Docs API.
 */
const paragraphElementSchema = z.object({
  textRun: textRunSchema.optional(),
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
  elements: z.array(paragraphElementSchema),
  paragraphStyle: paragraphStyleSchema.optional(),
});

/**
 * Structural element from Google Docs API.
 */
const structuralElementSchema = z.object({
  paragraph: paragraphSchema.optional(),
  // Note: Tables, lists, and other elements will be added in future iterations
});

/**
 * Document body from Google Docs API.
 */
const documentBodySchema = z.object({
  content: z.array(structuralElementSchema).optional(),
});

/**
 * Full document from Google Docs API.
 */
const googleDocsApiResponseSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  body: documentBodySchema,
  // Note: We may want to extract author/creation date in the future
  // but these require authenticated requests
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

/**
 * Converts Google Docs API structured content to HTML.
 *
 * This is a basic implementation that handles:
 * - Paragraphs
 * - Headings (H1-H6)
 * - Text styling (bold, italic, underline, strikethrough)
 * - Links
 *
 * Future enhancements may include:
 * - Lists (ordered/unordered)
 * - Tables
 * - Images
 * - More complex formatting
 */
function convertDocsApiToHtml(doc: z.infer<typeof googleDocsApiResponseSchema>): string {
  const htmlParts: string[] = [];

  if (!doc.body.content) {
    return "<p>Empty document</p>";
  }

  for (const element of doc.body.content) {
    if (!element.paragraph) {
      continue;
    }

    const paragraph = element.paragraph;
    const namedStyle = paragraph.paragraphStyle?.namedStyleType;

    // Determine the HTML tag based on paragraph style
    let openTag = "<p>";
    let closeTag = "</p>";

    if (namedStyle) {
      switch (namedStyle) {
        case "HEADING_1":
          openTag = "<h1>";
          closeTag = "</h1>";
          break;
        case "HEADING_2":
          openTag = "<h2>";
          closeTag = "</h2>";
          break;
        case "HEADING_3":
          openTag = "<h3>";
          closeTag = "</h3>";
          break;
        case "HEADING_4":
          openTag = "<h4>";
          closeTag = "</h4>";
          break;
        case "HEADING_5":
          openTag = "<h5>";
          closeTag = "</h5>";
          break;
        case "HEADING_6":
          openTag = "<h6>";
          closeTag = "</h6>";
          break;
        case "TITLE":
          // Treat title as H1
          openTag = "<h1>";
          closeTag = "</h1>";
          break;
        case "SUBTITLE":
          // Treat subtitle as H2
          openTag = "<h2>";
          closeTag = "</h2>";
          break;
      }
    }

    // Build the paragraph content with inline styles
    let paragraphContent = "";

    for (const elem of paragraph.elements) {
      if (!elem.textRun) {
        continue;
      }

      const textRun = elem.textRun;
      let text = textRun.content;

      // HTML escape the text
      text = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

      const style = textRun.textStyle;

      if (style) {
        // Apply text styles in order: link -> bold -> italic -> underline -> strikethrough
        if (style.link?.url) {
          text = `<a href="${style.link.url}">${text}</a>`;
        }
        if (style.bold) {
          text = `<strong>${text}</strong>`;
        }
        if (style.italic) {
          text = `<em>${text}</em>`;
        }
        if (style.underline) {
          text = `<u>${text}</u>`;
        }
        if (style.strikethrough) {
          text = `<s>${text}</s>`;
        }
      }

      paragraphContent += text;
    }

    // Only add the paragraph if it has content (not just whitespace)
    if (paragraphContent.trim()) {
      htmlParts.push(openTag + paragraphContent + closeTag);
    }
  }

  return htmlParts.join("\n");
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

    // Convert structured document to HTML
    const html = convertDocsApiToHtml(doc);

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

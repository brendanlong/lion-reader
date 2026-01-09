/**
 * Google Docs content fetcher.
 *
 * This module provides URL parsing utilities for Google Docs and delegates
 * content fetching to the Drive API module. It serves as a compatibility layer
 * that maintains the existing API while using the simpler Drive API approach.
 *
 * Supported document types:
 * - Native Google Docs (application/vnd.google-apps.document)
 * - Uploaded .docx files (application/vnd.openxmlformats-officedocument.wordprocessingml.document)
 *
 * Note: Tab support is not available with the Drive API export. URLs with ?tab=
 * parameters will fetch the full document. This is acceptable since multi-tab
 * documents are uncommon in practice.
 */

import { logger } from "@/lib/logger";
import {
  isGoogleDriveApiAvailable,
  fetchPublicGoogleDriveFile,
  fetchPrivateGoogleDriveFile,
  GOOGLE_DRIVE_SCOPE,
  type GoogleDriveContent,
} from "./drive";

// Re-export the Drive scope for use in saved.ts
export { GOOGLE_DRIVE_SCOPE };

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
 *
 * Note: Tab IDs are parsed but not used with the Drive API - the full document is fetched.
 */
export function extractTabId(url: string): string | null {
  try {
    const urlObj = new URL(url);
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
// Types
// ============================================================================

/**
 * Result from fetching Google Docs content.
 * Maintains backward compatibility with the previous API.
 */
export interface GoogleDocsContent {
  /** Document ID */
  docId: string;
  /** Document title */
  title: string;
  /** HTML content converted from document structure */
  html: string;
  /** Author (null - not available via Drive API) */
  author: string | null;
  /** Creation date (null - not available via Drive API) */
  createdAt: Date | null;
  /** Last modified date (null - not available via Drive API) */
  modifiedAt: Date | null;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Converts GoogleDriveContent to GoogleDocsContent for backward compatibility.
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
// Public API
// ============================================================================

/**
 * Checks if the Google Docs API is available (service account configured).
 */
export function isGoogleDocsApiAvailable(): boolean {
  return isGoogleDriveApiAvailable();
}

/**
 * Fetches a public Google Doc using the Google Drive API with service account credentials.
 *
 * Requires GOOGLE_SERVICE_ACCOUNT_JSON to be configured. The service account
 * authenticates the request and can access publicly shared documents.
 *
 * Supports both native Google Docs and uploaded .docx files.
 *
 * @param docId - The Google Docs document ID
 * @param tabId - Optional tab ID (parsed but not used - Drive API exports full document)
 * @returns Document content including HTML, or null if fetch fails or doc is private
 */
export async function fetchPublicGoogleDoc(
  docId: string,
  tabId: string | null = null
): Promise<GoogleDocsContent | null> {
  if (tabId) {
    logger.debug("Tab ID provided but not used with Drive API export", { docId, tabId });
  }

  const content = await fetchPublicGoogleDriveFile(docId);

  if (!content) {
    return null;
  }

  return driveContentToDocsContent(content);
}

/**
 * Fetches a private Google Doc using a user's OAuth access token.
 *
 * Used for accessing documents that the user has permission to read but
 * aren't publicly shared.
 *
 * Requires the user to have granted the 'drive.readonly' scope.
 *
 * @param docId - The Google Docs document ID
 * @param accessToken - User's OAuth access token with drive.readonly scope
 * @param tabId - Optional tab ID (parsed but not used - Drive API exports full document)
 * @returns Document content including HTML, or null if fetch fails
 * @throws Error if token is invalid or user doesn't have permission
 */
export async function fetchPrivateGoogleDoc(
  docId: string,
  accessToken: string,
  tabId: string | null = null
): Promise<GoogleDocsContent | null> {
  if (tabId) {
    logger.debug("Tab ID provided but not used with Drive API export", { docId, tabId });
  }

  const content = await fetchPrivateGoogleDriveFile(docId, accessToken);

  if (!content) {
    return null;
  }

  return driveContentToDocsContent(content);
}

/**
 * Fetches Google Docs content from a URL.
 *
 * This is a convenience function that extracts the document ID from the URL
 * and fetches the content using the public API.
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
  // Note: tabId is logged but not used with Drive API
  const tabId = extractTabId(url);

  return fetchPublicGoogleDoc(docId, tabId);
}

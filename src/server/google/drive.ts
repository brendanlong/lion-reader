/**
 * Google Drive content fetcher using the Google Drive API.
 *
 * This module provides access to Google Docs and uploaded Word documents via the
 * Drive API. It replaces the previous Docs API approach with a simpler implementation
 * that:
 *
 * 1. Uses files.get to determine the file type (native Google Doc vs uploaded .docx)
 * 2. For native Google Docs: uses files.export to get HTML directly from Google
 * 3. For uploaded .docx files: downloads the file and converts with mammoth
 *
 * Benefits over the Docs API approach:
 * - ~50 lines vs ~1000 lines of code
 * - Supports uploaded .docx files (Docs API fails with "operation not supported")
 * - Google handles HTML conversion for native docs (less maintenance)
 * - Same auth credentials work for both cases
 */

import * as mammoth from "mammoth";
import { GoogleAuth } from "google-auth-library";
import { logger } from "@/lib/logger";
import { googleConfig } from "@/server/config/env";
import { USER_AGENT } from "@/server/http/user-agent";

// ============================================================================
// Constants
// ============================================================================

/**
 * Google Drive API v3 endpoint.
 */
const GOOGLE_DRIVE_API_ENDPOINT = "https://www.googleapis.com/drive/v3/files";

/**
 * Timeout for API requests in milliseconds.
 */
const API_TIMEOUT_MS = 30000;

/**
 * OAuth2 scope required for reading Google Drive files.
 * This is more permissive than documents.readonly but required for the Drive API.
 */
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

/**
 * MIME types we handle.
 */
const MIME_TYPE_GOOGLE_DOC = "application/vnd.google-apps.document";
const MIME_TYPE_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
    scopes: [GOOGLE_DRIVE_SCOPE],
  });

  return googleAuthClient;
}

/**
 * Gets an access token for the Google Drive API using service account credentials.
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
// Types
// ============================================================================

/**
 * Result from fetching Google Drive content.
 */
export interface GoogleDriveContent {
  /** File ID */
  fileId: string;
  /** File name/title */
  title: string;
  /** HTML content */
  html: string;
  /** MIME type of the original file */
  mimeType: string;
}

/**
 * File metadata from Drive API.
 */
interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
}

// ============================================================================
// Drive API Functions
// ============================================================================

/**
 * Fetches file metadata from Google Drive.
 */
async function getFileMetadata(
  fileId: string,
  accessToken: string
): Promise<DriveFileMetadata | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const url = `${GOOGLE_DRIVE_API_ENDPOINT}/${fileId}?fields=id,name,mimeType`;

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
      const status = response.status;
      if (status === 401) {
        logger.warn("Drive API authentication failed", { fileId, status });
      } else if (status === 403) {
        logger.debug("File is private or not accessible", { fileId, status });
      } else if (status === 404) {
        logger.debug("File not found", { fileId });
      } else {
        logger.warn("Drive API request failed", { fileId, status });
      }
      return null;
    }

    const data = (await response.json()) as DriveFileMetadata;
    return data;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn("Drive API request timed out", { fileId });
    } else {
      logger.warn("Drive API request error", {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Exports a native Google Doc as HTML using the Drive API.
 */
async function exportGoogleDocAsHtml(fileId: string, accessToken: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const url = `${GOOGLE_DRIVE_API_ENDPOINT}/${fileId}/export?mimeType=text/html`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("Failed to export Google Doc as HTML", {
        fileId,
        status: response.status,
      });
      return null;
    }

    return await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn("Export request timed out", { fileId });
    } else {
      logger.warn("Export request error", {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Downloads a file from Google Drive as raw bytes.
 */
async function downloadFile(fileId: string, accessToken: string): Promise<ArrayBuffer | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const url = `${GOOGLE_DRIVE_API_ENDPOINT}/${fileId}?alt=media`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("Failed to download file", {
        fileId,
        status: response.status,
      });
      return null;
    }

    return await response.arrayBuffer();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn("Download request timed out", { fileId });
    } else {
      logger.warn("Download request error", {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Converts a .docx file to HTML using mammoth.
 *
 * Style mappings:
 * - Title paragraphs → h1
 * - Subtitle paragraphs → h2
 */
async function convertDocxToHtml(arrayBuffer: ArrayBuffer): Promise<string> {
  const styleMap = ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"];

  // Convert ArrayBuffer to Buffer for mammoth
  const buffer = Buffer.from(arrayBuffer);

  const result = await mammoth.convertToHtml({ buffer }, { styleMap });

  if (result.messages.length > 0) {
    logger.debug("Mammoth conversion messages", {
      messages: result.messages.map((m) => m.message),
    });
  }

  return result.value;
}

/**
 * Strips the title from exported Google Docs HTML if it matches the document title.
 *
 * Google's HTML export includes the title as a <p> with inline styles at the top.
 * Since we track the title separately, we remove it to avoid duplication.
 */
function stripTitleFromExportedHtml(html: string, title: string): string {
  // Google exports include the title as the first paragraph with specific styling
  // We look for a paragraph that contains text matching the title at the start of the body
  const normalizedTitle = title.toLowerCase().trim();

  // Match HTML export format: starts with <html><head>...</head><body>
  // The first element after <body...> is often the title
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)/i);
  if (!bodyMatch) {
    return html;
  }

  const bodyContent = bodyMatch[1];

  // Find the first paragraph or heading element
  const firstElementMatch = bodyContent.match(/^\s*<(p|h[1-6])[^>]*>([\s\S]*?)<\/\1>/i);
  if (!firstElementMatch) {
    return html;
  }

  const [fullMatch, , elementContent] = firstElementMatch;

  // Extract text content (strip HTML tags)
  const textContent = elementContent
    .replace(/<[^>]+>/g, "")
    .trim()
    .toLowerCase();

  // If the text matches the title, remove this element
  if (textContent === normalizedTitle) {
    const bodyStart = html.indexOf(bodyMatch[0]);
    const elementStart = bodyContent.indexOf(fullMatch);
    const beforeBody = html.slice(0, bodyStart + "<body".length);
    const bodyAttrs = bodyMatch[0].match(/<body([^>]*)>/i)?.[1] || "";
    const afterElement = bodyContent.slice(elementStart + fullMatch.length);

    return `${beforeBody}${bodyAttrs}>${afterElement}`;
  }

  return html;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Cleans up a file name to use as a display title.
 *
 * Removes:
 * - Common document extensions (.docx, .doc, .pdf, etc.)
 */
export function cleanTitle(name: string): string {
  let title = name.trim();

  // Remove common document extensions
  title = title.replace(/\.(docx?|pdf|odt|rtf|txt)$/i, "");

  return title;
}

/**
 * Checks if the Google Drive API is available (service account configured).
 */
export function isGoogleDriveApiAvailable(): boolean {
  return !!googleConfig.serviceAccountJson;
}

/**
 * Fetches a public Google Drive file using service account credentials.
 *
 * Handles both native Google Docs and uploaded .docx files:
 * - Native Google Docs: exported as HTML via Drive API
 * - Uploaded .docx: downloaded and converted with mammoth
 *
 * @param fileId - The Google Drive file ID
 * @returns File content including HTML, or null if fetch fails
 */
export async function fetchPublicGoogleDriveFile(
  fileId: string
): Promise<GoogleDriveContent | null> {
  if (!googleConfig.serviceAccountJson) {
    logger.debug("Google service account not configured", { fileId });
    return null;
  }

  const accessToken = await getServiceAccountAccessToken();
  if (!accessToken) {
    logger.warn("Failed to get service account access token", { fileId });
    return null;
  }

  return fetchGoogleDriveFileWithToken(fileId, accessToken);
}

/**
 * Fetches a Google Drive file using a user's OAuth access token.
 *
 * @param fileId - The Google Drive file ID
 * @param accessToken - User's OAuth access token with drive.readonly scope
 * @returns File content including HTML, or null if fetch fails
 * @throws Error with specific codes for auth/permission issues
 */
export async function fetchPrivateGoogleDriveFile(
  fileId: string,
  accessToken: string
): Promise<GoogleDriveContent | null> {
  return fetchGoogleDriveFileWithToken(fileId, accessToken);
}

/**
 * Internal function to fetch a file with an access token.
 */
async function fetchGoogleDriveFileWithToken(
  fileId: string,
  accessToken: string
): Promise<GoogleDriveContent | null> {
  // Step 1: Get file metadata to determine type
  logger.debug("Fetching file metadata", { fileId });
  const metadata = await getFileMetadata(fileId, accessToken);

  if (!metadata) {
    return null;
  }

  logger.debug("File metadata retrieved", {
    fileId,
    name: metadata.name,
    mimeType: metadata.mimeType,
  });

  // Step 2: Get content based on file type
  let html: string | null = null;

  if (metadata.mimeType === MIME_TYPE_GOOGLE_DOC) {
    // Native Google Doc - export as HTML
    logger.debug("Exporting native Google Doc as HTML", { fileId });
    html = await exportGoogleDocAsHtml(fileId, accessToken);

    if (html) {
      // Strip the title if it appears at the start of the document
      html = stripTitleFromExportedHtml(html, metadata.name);
    }
  } else if (metadata.mimeType === MIME_TYPE_DOCX) {
    // Uploaded .docx file - download and convert
    logger.debug("Downloading and converting .docx file", { fileId });
    const buffer = await downloadFile(fileId, accessToken);

    if (buffer) {
      html = await convertDocxToHtml(buffer);
    }
  } else {
    // Unsupported file type
    logger.warn("Unsupported file type for content extraction", {
      fileId,
      mimeType: metadata.mimeType,
    });
    return null;
  }

  if (!html) {
    return null;
  }

  return {
    fileId: metadata.id,
    title: cleanTitle(metadata.name),
    html,
    mimeType: metadata.mimeType,
  };
}

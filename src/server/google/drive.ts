/**
 * Google Drive API utilities for fetching uploaded .docx files.
 *
 * This module handles uploaded Word documents (.docx) that are stored in Google Drive.
 * Native Google Docs are handled by the Docs API in docs.ts for better formatting.
 *
 * Features:
 * - Fetches file metadata to determine file type
 * - Downloads .docx files and converts them to HTML using mammoth
 * - Supports both service account (public) and user OAuth (private) access
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
 * MIME types for Google Drive files.
 */
export const MIME_TYPE_GOOGLE_DOC = "application/vnd.google-apps.document";
export const MIME_TYPE_DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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
export interface DriveFileMetadata {
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
 * Gets a service account access token for Google APIs.
 * Exported for use by docs.ts to check file metadata.
 */
export async function getDriveServiceAccountToken(): Promise<string | null> {
  return getServiceAccountAccessToken();
}

/**
 * Fetches file metadata from Google Drive.
 * Used to determine if a file is a native Google Doc or an uploaded .docx.
 *
 * @param fileId - The Google Drive file ID
 * @param accessToken - OAuth access token with drive.readonly scope
 * @returns File metadata or null if fetch fails
 */
export async function fetchDriveFileMetadata(
  fileId: string,
  accessToken: string
): Promise<DriveFileMetadata | null> {
  return getFileMetadata(fileId, accessToken);
}

/**
 * Fetches a public .docx file from Google Drive using service account credentials.
 *
 * Only handles uploaded .docx files. Native Google Docs should be fetched
 * using the Docs API in docs.ts for better formatting.
 *
 * @param fileId - The Google Drive file ID
 * @returns File content including HTML, or null if fetch fails or not a .docx
 */
export async function fetchPublicDocxFile(fileId: string): Promise<GoogleDriveContent | null> {
  if (!googleConfig.serviceAccountJson) {
    logger.debug("Google service account not configured", { fileId });
    return null;
  }

  const accessToken = await getServiceAccountAccessToken();
  if (!accessToken) {
    logger.warn("Failed to get service account access token", { fileId });
    return null;
  }

  return fetchDocxFileWithToken(fileId, accessToken);
}

/**
 * Fetches a private .docx file from Google Drive using a user's OAuth access token.
 *
 * Only handles uploaded .docx files. Native Google Docs should be fetched
 * using the Docs API in docs.ts for better formatting.
 *
 * @param fileId - The Google Drive file ID
 * @param accessToken - User's OAuth access token with drive.readonly scope
 * @returns File content including HTML, or null if fetch fails or not a .docx
 */
export async function fetchPrivateDocxFile(
  fileId: string,
  accessToken: string
): Promise<GoogleDriveContent | null> {
  return fetchDocxFileWithToken(fileId, accessToken);
}

/**
 * Internal function to fetch a .docx file with an access token.
 * Returns null for native Google Docs (use Docs API instead).
 */
async function fetchDocxFileWithToken(
  fileId: string,
  accessToken: string
): Promise<GoogleDriveContent | null> {
  // Step 1: Get file metadata to determine type
  logger.debug("Fetching file metadata for .docx check", { fileId });
  const metadata = await getFileMetadata(fileId, accessToken);

  if (!metadata) {
    return null;
  }

  logger.debug("File metadata retrieved", {
    fileId,
    name: metadata.name,
    mimeType: metadata.mimeType,
  });

  // Only handle .docx files - native Google Docs should use Docs API
  if (metadata.mimeType !== MIME_TYPE_DOCX) {
    logger.debug("Not a .docx file, skipping Drive API fetch", {
      fileId,
      mimeType: metadata.mimeType,
    });
    return null;
  }

  // Download and convert .docx file
  logger.debug("Downloading and converting .docx file", { fileId });
  const buffer = await downloadFile(fileId, accessToken);

  if (!buffer) {
    return null;
  }

  const html = await convertDocxToHtml(buffer);

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

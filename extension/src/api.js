/**
 * Lion Reader API calls shared by the popup and the background worker.
 */

import { getServerUrl } from "./constants.js";

/**
 * Errors the server returns when saving a Google Doc needs the user to sign in
 * with Google or grant Docs access. The web auth flow walks them through it.
 * NEEDS_GOOGLE_SIGNIN and NEEDS_GOOGLE_REAUTH come back as 401s, so they must be
 * matched before a 401 is treated as an expired API token.
 */
const GOOGLE_PERMISSION_ERRORS = new Set([
  "NEEDS_DOCS_PERMISSION",
  "NEEDS_GOOGLE_SIGNIN",
  "NEEDS_GOOGLE_REAUTH",
]);

/**
 * Whether a saveArticle error means the save has to go through the web auth
 * flow (which saves the article itself once auth is sorted out).
 */
export function needsWebAuthFlow(err) {
  return err.message === "TOKEN_EXPIRED" || GOOGLE_PERMISSION_ERRORS.has(err.message);
}

/**
 * Save an article using Bearer token auth.
 */
export async function saveArticle(url, title, token) {
  const serverUrl = await getServerUrl();
  const apiUrl = `${serverUrl}/api/v1/saved`;

  const body = { url };
  if (title) body.title = title;

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));

    // trpc-to-openapi returns { message: "...", code: "..." } at top level
    const errorMessage = data.message || data.error?.message || `HTTP ${response.status}`;

    if (GOOGLE_PERMISSION_ERRORS.has(errorMessage)) {
      throw new Error(errorMessage);
    }

    if (response.status === 401) {
      // Token expired or revoked
      await chrome.storage.sync.remove(["apiToken"]);
      throw new Error("TOKEN_EXPIRED");
    }

    // Check if site blocked the request (502 Bad Gateway from our server)
    if (response.status === 502 || errorMessage.includes("blocked the request")) {
      throw new Error("SITE_BLOCKED");
    }

    throw new Error(errorMessage);
  }

  return await response.json();
}

/**
 * Lion Reader API calls shared by the popup and the background worker.
 */

import { createWebAuthUrl, getApiCredentials, hasServerPermission } from "./constants.js";

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
function needsWebAuthFlow(err) {
  return err.message === "TOKEN_EXPIRED" || GOOGLE_PERMISSION_ERRORS.has(err.message);
}

/**
 * Open the web auth flow, which saves the article and gets a new token. The
 * background worker picks the token up from the callback page.
 */
async function openWebAuthFlow(serverUrl, url, title) {
  await chrome.tabs.create({ url: await createWebAuthUrl(serverUrl, url, title) });
}

/**
 * Save an article to `serverUrl` using Bearer token auth.
 */
async function saveArticle(serverUrl, url, title, token) {
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
    const errorMessage = data.message || `HTTP ${response.status}`;

    if (GOOGLE_PERMISSION_ERRORS.has(errorMessage)) {
      throw new Error(errorMessage);
    }

    if (response.status === 401) {
      // Token expired or revoked
      await chrome.storage.sync.remove("apiCredentials");
      throw new Error("TOKEN_EXPIRED");
    }

    throw new Error(errorMessage);
  }

  return await response.json();
}

/**
 * Save `url` to the configured server with the stored token. Returns the saved
 * article, or null if it handed off instead: to the options page when the
 * server's host permission is missing, or to the web auth flow when there is
 * no token, it has expired, or Google permission is needed.
 */
export async function saveOrSignIn(url, title) {
  const { serverUrl, token } = await getApiCredentials();
  if (!(await hasServerPermission(serverUrl))) {
    await chrome.runtime.openOptionsPage();
    return null;
  }

  if (!token) {
    await openWebAuthFlow(serverUrl, url, title);
    return null;
  }

  try {
    return await saveArticle(serverUrl, url, title, token);
  } catch (err) {
    if (needsWebAuthFlow(err)) {
      await openWebAuthFlow(serverUrl, url, title);
      return null;
    }
    throw err;
  }
}

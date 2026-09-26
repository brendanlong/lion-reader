/**
 * Shared constants and storage helpers for the Lion Reader browser extension.
 */

/**
 * Default server URL used when no custom URL is configured.
 */
export const DEFAULT_SERVER_URL = "https://lionreader.com";

/**
 * Get the configured server URL from storage.
 */
export async function getServerUrl() {
  const result = await chrome.storage.sync.get(["serverUrl"]);
  return result.serverUrl || DEFAULT_SERVER_URL;
}

/**
 * Get the stored API token.
 */
export async function getApiToken() {
  const result = await chrome.storage.sync.get(["apiToken"]);
  return result.apiToken || null;
}

/**
 * URL of the web page that saves `url` and hands the extension a new token.
 */
export async function getWebAuthUrl(url, title) {
  const serverUrl = await getServerUrl();
  let authUrl = `${serverUrl}/extension/save?url=${encodeURIComponent(url)}`;
  if (title) {
    authUrl += `&title=${encodeURIComponent(title)}`;
  }
  return authUrl;
}

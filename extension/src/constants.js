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

/**
 * Host permission pattern covering every URL on `serverUrl`'s origin.
 */
export function serverOriginPattern(serverUrl) {
  return `${new URL(serverUrl).origin}/*`;
}

/**
 * Whether the extension may talk to the configured server. A self-hosted server
 * is an optional host permission the options page requests, and permissions
 * don't sync between browsers the way the server URL does.
 */
export async function hasServerPermission() {
  const serverUrl = await getServerUrl();
  return chrome.permissions.contains({ origins: [serverOriginPattern(serverUrl)] });
}

/**
 * Whether `url` is the configured server's extension callback page. Only that
 * server may hand us a token: any other site could otherwise plant its own.
 */
export async function isServerCallbackUrl(url) {
  const serverUrl = await getServerUrl();
  return url.origin === new URL(serverUrl).origin && url.pathname === "/extension/callback";
}

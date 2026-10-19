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
 * The configured server and the token it issued, or a null token if we have
 * none for this server. Read together so a save never sends one server's
 * token to another. Tokens stored before `apiTokenOrigin` existed could only
 * come from the default server.
 */
export async function getApiCredentials() {
  const result = await chrome.storage.sync.get(["serverUrl", "apiToken", "apiTokenOrigin"]);
  const serverUrl = result.serverUrl || DEFAULT_SERVER_URL;
  const tokenOrigin = result.apiTokenOrigin || new URL(DEFAULT_SERVER_URL).origin;
  const token = tokenOrigin === new URL(serverUrl).origin ? result.apiToken || null : null;
  return { serverUrl, token };
}

/**
 * How long a sign-in started by the extension may take before its callback is
 * rejected; long enough to log in and grant Google Docs access.
 */
const AUTH_STATE_TTL_MS = 30 * 60 * 1000;

/**
 * URL of the web page on `serverUrl` that saves `url` and hands the extension
 * a new token. Records a one-time state the callback must echo, so a link to
 * the callback page with someone else's token can't sign the extension in.
 */
export async function createWebAuthUrl(serverUrl, url, title) {
  const state = crypto.randomUUID();
  const { pendingAuthStates = {} } = await chrome.storage.session.get("pendingAuthStates");
  const now = Date.now();
  const pending = Object.fromEntries(
    Object.entries(pendingAuthStates).filter(([, entry]) => entry.expiresAt > now)
  );
  pending[state] = { origin: new URL(serverUrl).origin, expiresAt: now + AUTH_STATE_TTL_MS };
  await chrome.storage.session.set({ pendingAuthStates: pending });

  let authUrl = `${serverUrl}/extension/save?url=${encodeURIComponent(url)}`;
  if (title) {
    authUrl += `&title=${encodeURIComponent(title)}`;
  }
  return `${authUrl}&state=${encodeURIComponent(state)}`;
}

/**
 * Consume the pending sign-in `state`, returning whether it was started by
 * this extension for `origin` and hasn't expired.
 */
export async function consumeAuthState(state, origin) {
  const { pendingAuthStates = {} } = await chrome.storage.session.get("pendingAuthStates");
  const entry = pendingAuthStates[state];
  if (!entry) {
    return false;
  }
  delete pendingAuthStates[state];
  await chrome.storage.session.set({ pendingAuthStates });
  return entry.origin === origin && entry.expiresAt > Date.now();
}

/**
 * Host permission pattern covering every URL on `serverUrl`'s origin.
 */
export function serverOriginPattern(serverUrl) {
  return `${new URL(serverUrl).origin}/*`;
}

/**
 * Whether the extension may talk to `serverUrl`. A self-hosted server
 * is an optional host permission the options page requests, and permissions
 * don't sync between browsers the way the server URL does.
 */
export async function hasServerPermission(serverUrl) {
  return chrome.permissions.contains({ origins: [serverOriginPattern(serverUrl)] });
}

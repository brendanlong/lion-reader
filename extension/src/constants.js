/**
 * Shared constants and storage helpers for the Lion Reader browser extension.
 */

/**
 * Default server URL used when no custom URL is configured.
 */
export const DEFAULT_SERVER_URL = "https://lionreader.com";

/**
 * The configured server and the token it issued, or a null token if we have
 * none for this server, so a save never sends one server's token to another.
 * The token and its origin share one sync key because sync resolves conflicts
 * per key.
 */
export async function getApiCredentials() {
  const { serverUrl, apiCredentials } = await chrome.storage.sync.get([
    "serverUrl",
    "apiCredentials",
  ]);
  const server = serverUrl || DEFAULT_SERVER_URL;
  const token = apiCredentials?.origin === new URL(server).origin ? apiCredentials.token : null;
  return { serverUrl: server, token };
}

/**
 * How long a sign-in started by the extension may take before its callback is
 * rejected; long enough to log in and grant Google Docs access.
 */
const AUTH_STATE_TTL_MS = 30 * 60 * 1000;

/**
 * Pending sign-in states each get their own session key, so concurrent saves
 * don't overwrite each other's.
 */
const AUTH_STATE_KEY_PREFIX = "authState:";

/**
 * URL of the web page on `serverUrl` that saves `url` and hands the extension
 * a new token. Records a one-time state the callback must echo, so a link to
 * the callback page with someone else's token can't sign the extension in.
 */
export async function createWebAuthUrl(serverUrl, url, title) {
  const now = Date.now();
  const session = await chrome.storage.session.get(null);
  const expired = Object.keys(session).filter(
    (key) => key.startsWith(AUTH_STATE_KEY_PREFIX) && session[key].expiresAt <= now
  );
  await chrome.storage.session.remove(expired);

  const state = crypto.randomUUID();
  await chrome.storage.session.set({
    [AUTH_STATE_KEY_PREFIX + state]: {
      origin: new URL(serverUrl).origin,
      expiresAt: now + AUTH_STATE_TTL_MS,
    },
  });

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
  const key = AUTH_STATE_KEY_PREFIX + state;
  const { [key]: entry } = await chrome.storage.session.get(key);
  if (!entry) {
    return false;
  }
  await chrome.storage.session.remove(key);
  return entry.origin === origin && entry.expiresAt > Date.now();
}

/**
 * Host permission pattern covering `serverUrl`'s host. Without the port, which
 * Firefox match patterns don't support.
 */
export function serverHostPattern(serverUrl) {
  const { protocol, hostname } = new URL(serverUrl);
  return `${protocol}//${hostname}/*`;
}

/**
 * Whether the extension may talk to `serverUrl`. A self-hosted server
 * is an optional host permission the options page requests, and permissions
 * don't sync between browsers the way the server URL does.
 */
export async function hasServerPermission(serverUrl) {
  return chrome.permissions.contains({ origins: [serverHostPattern(serverUrl)] });
}

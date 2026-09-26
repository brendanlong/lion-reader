/**
 * Background service worker for Lion Reader browser extension.
 *
 * Handles:
 * - Detecting callback URL after web auth flow
 * - Storing API tokens
 * - Context menu creation and clicks
 * - Keyboard shortcut commands
 * - Badge updates
 */

import { getApiToken, getServerUrl, getWebAuthUrl } from "./constants.js";

/**
 * Store the API token.
 */
async function setApiToken(token) {
  await chrome.storage.sync.set({ apiToken: token });
}

/**
 * Save an article to Lion Reader using Bearer token auth.
 */
async function saveArticle(url, title, token) {
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

    if (response.status === 401) {
      // Token expired or revoked
      await chrome.storage.sync.remove(["apiToken"]);
      throw new Error("TOKEN_EXPIRED");
    }

    throw new Error(data.error?.message || `HTTP ${response.status}`);
  }

  return await response.json();
}

/**
 * Open the web auth flow to save an article and get a token.
 */
async function openWebAuthFlow(url, title) {
  await chrome.tabs.create({ url: await getWebAuthUrl(url, title) });
}

/**
 * Set the tab's badge, clearing it after `clearAfterMs` if given.
 */
async function setBadge(tabId, text, color, clearAfterMs) {
  await chrome.action.setBadgeText({ text, tabId });
  await chrome.action.setBadgeBackgroundColor({ color, tabId });
  if (clearAfterMs) {
    setTimeout(async () => {
      await chrome.action.setBadgeText({ text: "", tabId });
    }, clearAfterMs);
  }
}

/**
 * Save `url` using the stored token, reporting progress on the tab's badge.
 * Falls back to web auth flow if there is no token or it has expired.
 */
async function saveWithBadge(tabId, url, title, failureLog) {
  const token = await getApiToken();

  if (!token) {
    await openWebAuthFlow(url, title);
    return;
  }

  await setBadge(tabId, "...", "#71717a");

  try {
    await saveArticle(url, title, token);
    await setBadge(tabId, "\u2713", "#16a34a", 2000);
  } catch (err) {
    console.error(failureLog, err);

    if (err.message === "TOKEN_EXPIRED") {
      await openWebAuthFlow(url, title);
      await chrome.action.setBadgeText({ text: "", tabId });
      return;
    }

    await setBadge(tabId, "!", "#dc2626", 3000);
  }
}

/**
 * Save the current tab's page.
 */
async function saveCurrentTab(tab) {
  if (!tab || !tab.url) {
    console.error("No tab URL available");
    return;
  }

  await saveWithBadge(tab.id, tab.url, tab.title, "Save failed:");
}

// Create context menu on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "save-to-lion-reader",
    title: "Save to Lion Reader",
    contexts: ["page", "link"],
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "save-to-lion-reader") {
    if (info.linkUrl) {
      await saveWithBadge(tab.id, info.linkUrl, null, "Save link failed:");
    } else {
      // Saving current page
      await saveCurrentTab(tab);
    }
  }
});

// Handle keyboard shortcut commands
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "save-page") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await saveCurrentTab(tab);
    }
  }
});

// Listen for navigation to the callback URL to extract and store the token
chrome.webNavigation.onCompleted.addListener(
  async (details) => {
    try {
      const url = new URL(details.url);
      const token = url.searchParams.get("token");
      const status = url.searchParams.get("status");

      if (status === "success" && token) {
        // Store the token
        await setApiToken(token);
        console.log("API token stored successfully");

        // Close the tab after a short delay to let the user see the success message
        setTimeout(async () => {
          try {
            await chrome.tabs.remove(details.tabId);
          } catch (err) {
            // Tab might already be closed
            console.log("Could not close tab:", err.message);
          }
        }, 1500);
      }
    } catch (err) {
      console.error("Error processing callback:", err);
    }
  },
  {
    url: [
      { hostEquals: "lion-reader.fly.dev", pathPrefix: "/extension/callback" },
      { hostEquals: "lionreader.com", pathPrefix: "/extension/callback" },
      { hostEquals: "localhost", pathPrefix: "/extension/callback" },
    ],
  }
);

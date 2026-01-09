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

const DEFAULT_SERVER_URL = "https://lion-reader.fly.dev";

/**
 * Get the configured server URL from storage.
 */
async function getServerUrl() {
  const result = await chrome.storage.sync.get(["serverUrl"]);
  return result.serverUrl || DEFAULT_SERVER_URL;
}

/**
 * Get the stored API token.
 */
async function getApiToken() {
  const result = await chrome.storage.sync.get(["apiToken"]);
  return result.apiToken || null;
}

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
  const serverUrl = await getServerUrl();
  let authUrl = `${serverUrl}/extension/save?url=${encodeURIComponent(url)}`;
  if (title) {
    authUrl += `&title=${encodeURIComponent(title)}`;
  }

  await chrome.tabs.create({ url: authUrl });
}

/**
 * Save the current tab's page using the stored token.
 * Falls back to web auth flow if no token.
 */
async function saveCurrentTab(tab) {
  if (!tab || !tab.url) {
    console.error("No tab URL available");
    return;
  }

  const token = await getApiToken();

  if (!token) {
    // No token - open web auth flow
    await openWebAuthFlow(tab.url, tab.title);
    return;
  }

  // Show saving badge
  await chrome.action.setBadgeText({ text: "...", tabId: tab.id });
  await chrome.action.setBadgeBackgroundColor({ color: "#71717a", tabId: tab.id });

  try {
    await saveArticle(tab.url, tab.title, token);

    // Show success badge
    await chrome.action.setBadgeText({ text: "\u2713", tabId: tab.id });
    await chrome.action.setBadgeBackgroundColor({ color: "#16a34a", tabId: tab.id });

    // Clear badge after 2 seconds
    setTimeout(async () => {
      await chrome.action.setBadgeText({ text: "", tabId: tab.id });
    }, 2000);
  } catch (err) {
    console.error("Save failed:", err);

    if (err.message === "TOKEN_EXPIRED") {
      // Token expired - open web auth flow
      await openWebAuthFlow(tab.url, tab.title);
      await chrome.action.setBadgeText({ text: "", tabId: tab.id });
      return;
    }

    // Show error badge
    await chrome.action.setBadgeText({ text: "!", tabId: tab.id });
    await chrome.action.setBadgeBackgroundColor({ color: "#dc2626", tabId: tab.id });

    // Clear badge after 3 seconds
    setTimeout(async () => {
      await chrome.action.setBadgeText({ text: "", tabId: tab.id });
    }, 3000);
  }
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
    const token = await getApiToken();

    if (info.linkUrl) {
      // Saving a link
      if (!token) {
        await openWebAuthFlow(info.linkUrl, null);
        return;
      }

      await chrome.action.setBadgeText({ text: "...", tabId: tab.id });
      await chrome.action.setBadgeBackgroundColor({ color: "#71717a", tabId: tab.id });

      try {
        await saveArticle(info.linkUrl, null, token);
        await chrome.action.setBadgeText({ text: "\u2713", tabId: tab.id });
        await chrome.action.setBadgeBackgroundColor({ color: "#16a34a", tabId: tab.id });
        setTimeout(async () => {
          await chrome.action.setBadgeText({ text: "", tabId: tab.id });
        }, 2000);
      } catch (err) {
        console.error("Save link failed:", err);

        if (err.message === "TOKEN_EXPIRED") {
          await openWebAuthFlow(info.linkUrl, null);
          await chrome.action.setBadgeText({ text: "", tabId: tab.id });
          return;
        }

        await chrome.action.setBadgeText({ text: "!", tabId: tab.id });
        await chrome.action.setBadgeBackgroundColor({ color: "#dc2626", tabId: tab.id });
        setTimeout(async () => {
          await chrome.action.setBadgeText({ text: "", tabId: tab.id });
        }, 3000);
      }
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
      { hostEquals: "localhost", pathPrefix: "/extension/callback" },
    ],
  }
);

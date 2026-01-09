/**
 * Background service worker for Lion Reader browser extension.
 *
 * Handles:
 * - Context menu creation and clicks
 * - Keyboard shortcut commands
 * - Badge updates
 */

const DEFAULT_SERVER_URL = "https://lionreader.com";

/**
 * Get the configured server URL from storage.
 */
async function getServerUrl() {
  const result = await chrome.storage.sync.get(["serverUrl"]);
  return result.serverUrl || DEFAULT_SERVER_URL;
}

/**
 * Capture the current page's content using scripting API.
 */
async function capturePageContent(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        return {
          url: window.location.href,
          title: document.title,
          html: document.documentElement.outerHTML,
        };
      },
    });

    if (results && results[0] && results[0].result) {
      return results[0].result;
    }
  } catch (err) {
    console.error("Failed to capture page content:", err);
  }

  return null;
}

/**
 * Save an article to Lion Reader.
 */
async function saveArticle(url, html, title) {
  const serverUrl = await getServerUrl();
  const apiUrl = `${serverUrl}/api/v1/saved`;

  const body = { url };
  if (html) body.html = html;
  if (title) body.title = title;

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      throw new Error("Please sign in to Lion Reader first");
    }

    throw new Error(data.error?.message || `HTTP ${response.status}`);
  }

  return await response.json();
}

/**
 * Save the current tab's page.
 */
async function saveCurrentTab(tab) {
  if (!tab || !tab.url) {
    console.error("No tab URL available");
    return;
  }

  // Show saving badge
  await chrome.action.setBadgeText({ text: "...", tabId: tab.id });
  await chrome.action.setBadgeBackgroundColor({ color: "#71717a", tabId: tab.id });

  try {
    // Check if we can access this page
    const canCapture =
      !tab.url.startsWith("chrome://") &&
      !tab.url.startsWith("chrome-extension://") &&
      !tab.url.startsWith("moz-extension://") &&
      !tab.url.startsWith("about:") &&
      !tab.url.startsWith("edge://");

    let html = null;
    let title = null;

    if (canCapture) {
      const content = await capturePageContent(tab.id);
      if (content) {
        html = content.html;
        title = content.title;
      }
    }

    // Save to Lion Reader
    await saveArticle(tab.url, html, title);

    // Show success badge
    await chrome.action.setBadgeText({ text: "\u2713", tabId: tab.id });
    await chrome.action.setBadgeBackgroundColor({ color: "#16a34a", tabId: tab.id });

    // Clear badge after 2 seconds
    setTimeout(async () => {
      await chrome.action.setBadgeText({ text: "", tabId: tab.id });
    }, 2000);
  } catch (err) {
    console.error("Save failed:", err);

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
    if (info.linkUrl) {
      // Saving a link - just send the URL without content
      await chrome.action.setBadgeText({ text: "...", tabId: tab.id });
      await chrome.action.setBadgeBackgroundColor({ color: "#71717a", tabId: tab.id });

      try {
        await saveArticle(info.linkUrl, null, null);
        await chrome.action.setBadgeText({ text: "\u2713", tabId: tab.id });
        await chrome.action.setBadgeBackgroundColor({ color: "#16a34a", tabId: tab.id });
        setTimeout(async () => {
          await chrome.action.setBadgeText({ text: "", tabId: tab.id });
        }, 2000);
      } catch (err) {
        console.error("Save link failed:", err);
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

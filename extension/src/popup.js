/**
 * Popup script for Lion Reader browser extension.
 *
 * Handles saving the current page to Lion Reader using API tokens.
 * If no token exists, opens the web auth flow to get one.
 */

// DOM Elements
const loadingEl = document.getElementById("loading");
const loadingUrlEl = document.getElementById("loading-url");
const successEl = document.getElementById("success");
const successTitleEl = document.getElementById("success-title");
const countdownEl = document.getElementById("countdown");
const closeBtn = document.getElementById("close-btn");
const errorEl = document.getElementById("error");
const errorAlertEl = document.getElementById("error-alert");
const errorUrlEl = document.getElementById("error-url");
const errorCloseBtn = document.getElementById("error-close-btn");
const retryBtn = document.getElementById("retry-btn");
const notConfiguredEl = document.getElementById("not-configured");
const openOptionsBtn = document.getElementById("open-options-btn");
const notSignedInEl = document.getElementById("not-signed-in");
const openLionReaderBtn = document.getElementById("open-lionreader-btn");

// State
let currentUrl = null;
let currentTitle = null;
let countdownInterval = null;

// Default server URL
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
 * Show a specific state, hiding all others.
 */
function showState(state) {
  loadingEl.classList.add("hidden");
  successEl.classList.add("hidden");
  errorEl.classList.add("hidden");
  notConfiguredEl.classList.add("hidden");
  notSignedInEl.classList.add("hidden");

  const el = document.getElementById(state);
  if (el) {
    el.classList.remove("hidden");
  }
}

/**
 * Start the auto-close countdown.
 */
function startCountdown(seconds = 3) {
  let remaining = seconds;
  countdownEl.textContent = `Closing in ${remaining}...`;

  countdownInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(countdownInterval);
      window.close();
    } else {
      countdownEl.textContent = `Closing in ${remaining}...`;
    }
  }, 1000);
}

/**
 * Save the article using the API with Bearer token auth.
 */
async function saveWithToken(url, title, token) {
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

    // Token might be expired or revoked
    if (response.status === 401) {
      // Clear the invalid token
      await chrome.storage.sync.remove(["apiToken"]);
      throw new Error("TOKEN_EXPIRED");
    }

    throw new Error(data.error?.message || `HTTP ${response.status}`);
  }

  return await response.json();
}

/**
 * Open the web auth flow to get a new token.
 * The background script will detect the callback and store the token.
 */
async function startWebAuthFlow(url, title) {
  const serverUrl = await getServerUrl();
  let authUrl = `${serverUrl}/extension/save?url=${encodeURIComponent(url)}`;
  if (title) {
    authUrl += `&title=${encodeURIComponent(title)}`;
  }

  // Open the auth page in a new tab
  await chrome.tabs.create({ url: authUrl });

  // Close the popup - the background script will handle the callback
  window.close();
}

/**
 * Main save flow.
 */
async function save() {
  showState("loading");

  try {
    // Get the current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url) {
      throw new Error("No active tab found");
    }

    currentUrl = tab.url;
    currentTitle = tab.title || null;
    loadingUrlEl.textContent = currentUrl;

    // Check if we have a token
    const token = await getApiToken();

    if (!token) {
      // No token - start web auth flow
      await startWebAuthFlow(currentUrl, currentTitle);
      return;
    }

    // Try to save with the token
    try {
      const result = await saveWithToken(currentUrl, currentTitle, token);

      // Show success
      showState("success");
      if (result.article?.title) {
        successTitleEl.textContent = result.article.title;
        successTitleEl.classList.remove("hidden");
      } else {
        successTitleEl.classList.add("hidden");
      }

      startCountdown(3);
    } catch (err) {
      if (err.message === "TOKEN_EXPIRED") {
        // Token expired - start web auth flow to get a new one
        await startWebAuthFlow(currentUrl, currentTitle);
        return;
      }
      throw err;
    }
  } catch (err) {
    console.error("Save failed:", err);
    showState("error");
    errorAlertEl.textContent = err.message || "Failed to save article";
    errorUrlEl.textContent = currentUrl || "";
  }
}

// Event listeners
closeBtn.addEventListener("click", () => window.close());
errorCloseBtn.addEventListener("click", () => window.close());

retryBtn.addEventListener("click", () => {
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }
  save();
});

openOptionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

openLionReaderBtn.addEventListener("click", async () => {
  const serverUrl = await getServerUrl();
  chrome.tabs.create({ url: serverUrl });
  window.close();
});

// Start saving when popup opens
save();

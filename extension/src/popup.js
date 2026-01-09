/**
 * Popup script for Lion Reader browser extension.
 *
 * Handles saving the current page to Lion Reader, including
 * capturing page content for authenticated pages.
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
 * Save the article to Lion Reader.
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

    // Check for authentication errors
    if (response.status === 401) {
      throw new Error("NOT_SIGNED_IN");
    }

    throw new Error(data.error?.message || `HTTP ${response.status}`);
  }

  return await response.json();
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
    loadingUrlEl.textContent = currentUrl;

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
      // Try to capture page content
      const content = await capturePageContent(tab.id);
      if (content) {
        html = content.html;
        title = content.title;
      }
    }

    // Save to Lion Reader
    const result = await saveArticle(currentUrl, html, title);

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
    console.error("Save failed:", err);

    if (err.message === "NOT_SIGNED_IN") {
      showState("not-signed-in");
    } else {
      showState("error");
      errorAlertEl.textContent = err.message || "Failed to save article";
      errorUrlEl.textContent = currentUrl || "";
    }
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

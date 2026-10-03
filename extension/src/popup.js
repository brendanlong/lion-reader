/**
 * Popup script for Lion Reader browser extension.
 *
 * Handles saving the current page to Lion Reader using API tokens.
 * If no token exists, opens the web auth flow to get one.
 */

import { needsWebAuthFlow, saveArticle } from "./api.js";
import { getApiToken, getWebAuthUrl } from "./constants.js";

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

// State
let currentUrl = null;
let currentTitle = null;
let countdownInterval = null;

/**
 * Show a specific state, hiding all others.
 */
function showState(state) {
  loadingEl.classList.add("hidden");
  successEl.classList.add("hidden");
  errorEl.classList.add("hidden");

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
 * Open the web auth flow to get a new token.
 * The background script will detect the callback and store the token.
 */
async function startWebAuthFlow(url, title) {
  // Open the auth page in a new tab
  await chrome.tabs.create({ url: await getWebAuthUrl(url, title) });

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
      const result = await saveArticle(currentUrl, currentTitle, token);

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
      if (needsWebAuthFlow(err)) {
        await startWebAuthFlow(currentUrl, currentTitle);
        return;
      }
      throw err;
    }
  } catch (err) {
    console.error("Save failed:", err);
    showState("error");

    // Show friendly message for blocked sites
    if (err.message === "SITE_BLOCKED") {
      errorAlertEl.textContent =
        "This website blocked our request. Some sites don't allow automated access.";
    } else {
      errorAlertEl.textContent = err.message || "Failed to save article";
    }
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

// Start saving when popup opens
save();

/**
 * Popup script for Lion Reader browser extension.
 *
 * Handles saving the current page to Lion Reader using API tokens.
 * If no token exists, opens the web auth flow to get one.
 */

import { saveOrSignIn } from "./api.js";

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
 * Main save flow.
 */
async function save() {
  showState("loading");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url) {
      throw new Error("No active tab found");
    }

    currentUrl = tab.url;
    currentTitle = tab.title || null;
    loadingUrlEl.textContent = currentUrl;

    const result = await saveOrSignIn(currentUrl, currentTitle);
    if (!result) {
      // Handed off to the options page or the web auth flow
      window.close();
      return;
    }

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

// Start saving when popup opens
save();

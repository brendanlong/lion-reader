/**
 * Options page script for Lion Reader browser extension.
 */

import { DEFAULT_SERVER_URL, hasServerPermission, serverHostPattern } from "./constants.js";

// DOM Elements
const serverUrlInput = document.getElementById("server-url");
const saveBtn = document.getElementById("save-btn");
const resetBtn = document.getElementById("reset-btn");
const statusEl = document.getElementById("status");
const permissionWarningEl = document.getElementById("permission-warning");
const shortcutsLink = document.getElementById("shortcuts-link");
const shortcutKeyEl = document.getElementById("shortcut-key");

/**
 * Load saved settings.
 */
async function loadSettings() {
  const result = await chrome.storage.sync.get(["serverUrl"]);
  serverUrlInput.value = result.serverUrl || "";
  serverUrlInput.placeholder = DEFAULT_SERVER_URL;
  permissionWarningEl.hidden = await hasServerPermission(result.serverUrl || DEFAULT_SERVER_URL);
}

/**
 * Show a status message next to the buttons for a couple of seconds.
 */
function showStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.add("visible");
  setTimeout(() => {
    statusEl.classList.remove("visible");
  }, 2000);
}

/**
 * Save settings.
 */
async function saveSettings() {
  let url = serverUrlInput.value.trim();

  // Remove trailing slash
  if (url.endsWith("/")) {
    url = url.slice(0, -1);
  }

  // Validate URL if provided
  if (url) {
    let protocol;
    try {
      protocol = new URL(url).protocol;
    } catch {
      protocol = null;
    }
    if (protocol !== "https:" && protocol !== "http:") {
      alert("Please enter a valid http:// or https:// URL");
      return;
    }
  }

  // Firefox only shows the permission prompt if it's requested before the
  // handler for the click or keypress awaits anything.
  const granted = await chrome.permissions.request({
    origins: [serverHostPattern(url || DEFAULT_SERVER_URL)],
  });
  if (!granted) {
    alert("Lion Reader needs access to your server to save articles there.");
    return;
  }

  await chrome.storage.sync.set({ serverUrl: url });
  permissionWarningEl.hidden = true;
  showStatus("Saved!");
}

/**
 * Reset to default settings.
 */
async function resetSettings() {
  serverUrlInput.value = "";
  await chrome.storage.sync.set({ serverUrl: "" });
  permissionWarningEl.hidden = await hasServerPermission(DEFAULT_SERVER_URL);
  showStatus("Reset!");
}

/**
 * Load and display keyboard shortcut.
 */
async function loadShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const saveCommand = commands.find((c) => c.name === "save-page");
    if (saveCommand && saveCommand.shortcut) {
      shortcutKeyEl.textContent = saveCommand.shortcut;
    } else {
      shortcutKeyEl.textContent = "Not set";
    }
  } catch {
    // Commands API might not be available
  }
}

/**
 * Open browser's extension shortcuts page.
 */
function openShortcutsPage(e) {
  e.preventDefault();

  // Different browsers have different URLs for this
  const isFirefox = navigator.userAgent.includes("Firefox");
  const isEdge = navigator.userAgent.includes("Edg/");

  if (isFirefox) {
    chrome.tabs.create({ url: "about:addons" });
  } else if (isEdge) {
    chrome.tabs.create({ url: "edge://extensions/shortcuts" });
  } else {
    // Chrome and others
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  }
}

// Event listeners
saveBtn.addEventListener("click", saveSettings);
resetBtn.addEventListener("click", resetSettings);
shortcutsLink.addEventListener("click", openShortcutsPage);

// Allow saving with Enter key
serverUrlInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    saveSettings();
  }
});

// Load settings on page load
loadSettings();
loadShortcut();

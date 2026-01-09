/**
 * Options page script for Lion Reader browser extension.
 */

const DEFAULT_SERVER_URL = "https://lion-reader.fly.dev";

// DOM Elements
const serverUrlInput = document.getElementById("server-url");
const saveBtn = document.getElementById("save-btn");
const resetBtn = document.getElementById("reset-btn");
const statusEl = document.getElementById("status");
const shortcutsLink = document.getElementById("shortcuts-link");
const shortcutKeyEl = document.getElementById("shortcut-key");

/**
 * Load saved settings.
 */
async function loadSettings() {
  const result = await chrome.storage.sync.get(["serverUrl"]);
  serverUrlInput.value = result.serverUrl || "";
  serverUrlInput.placeholder = DEFAULT_SERVER_URL;
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
    try {
      new URL(url);
    } catch {
      alert("Please enter a valid URL");
      return;
    }
  }

  await chrome.storage.sync.set({ serverUrl: url || "" });

  // Show saved status
  statusEl.classList.add("visible");
  setTimeout(() => {
    statusEl.classList.remove("visible");
  }, 2000);
}

/**
 * Reset to default settings.
 */
async function resetSettings() {
  serverUrlInput.value = "";
  await chrome.storage.sync.set({ serverUrl: "" });

  // Show saved status
  statusEl.textContent = "Reset!";
  statusEl.classList.add("visible");
  setTimeout(() => {
    statusEl.classList.remove("visible");
    statusEl.textContent = "Saved!";
  }, 2000);
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

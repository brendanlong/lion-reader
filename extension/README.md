# Lion Reader Browser Extension

A cross-browser extension for saving articles to Lion Reader.

## Features

- **One-click save** - Click the toolbar icon to save the current page
- **Keyboard shortcut** - Press `Ctrl+Shift+S` (or `Cmd+Shift+S` on Mac) to save
- **Context menu** - Right-click on any page or link and select "Save to Lion Reader"
- **Self-hosted support** - Configure a custom server URL for self-hosted instances

## Browser Compatibility

This extension uses Manifest V3 (WebExtensions API) and works on:

- Google Chrome (version 88+)
- Mozilla Firefox (version 142+)
- Microsoft Edge (version 88+)
- Other Chromium-based browsers

## Installation

### From Store

- **Chrome/Edge:** [Chrome Web Store](https://chromewebstore.google.com/detail/lion-reader/mpjddkjjkckmclaifjfokjppfoenmlpl)
- **Firefox:** [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/lion-reader/)

### From Source (Development)

**Chrome/Edge:**

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension` directory

**Firefox:**
Firefox requires a modified manifest due to Manifest V3 differences. Run the build script first:

```bash
cd extension
./build.sh
```

Then:

1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `lion-reader-firefox.zip` (or extract it and select the manifest.json inside)

### Building for Distribution

```bash
cd extension
./build.sh
```

This creates browser-specific packages:

- `lion-reader-chrome.zip` - For Chrome, Edge, and Chromium-based browsers
- `lion-reader-firefox.zip` - For Firefox (uses `scripts` instead of `service_worker`)

## Configuration

Click the extension icon and select "Settings" (or right-click the icon and choose "Options") to:

- Set a custom server URL for self-hosted instances
- View and customize keyboard shortcuts

## Privacy

- The extension only activates when you explicitly save a page
- The page URL and title are sent directly to your Lion Reader server
- No data is sent to any third parties
- For self-hosted instances, all data stays on your server

# Lion Reader Browser Extension

A cross-browser extension for saving articles to Lion Reader.

## Features

- **One-click save** - Click the toolbar icon to save the current page
- **Keyboard shortcut** - Press `Ctrl+Shift+S` (or `Cmd+Shift+S` on Mac) to save
- **Context menu** - Right-click on any page or link and select "Save to Lion Reader"
- **Authenticated content** - Captures page content from the browser, so you can save paywalled articles, Substacks, and other authenticated content
- **Self-hosted support** - Configure a custom server URL for self-hosted instances

## Browser Compatibility

This extension uses Manifest V3 (WebExtensions API) and works on:

- Google Chrome (version 88+)
- Mozilla Firefox (version 109+)
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

## Usage

1. **Sign in** to Lion Reader in your browser first
2. Navigate to any article you want to save
3. Click the Lion Reader icon in your toolbar, or:
   - Press `Ctrl+Shift+S` / `Cmd+Shift+S`
   - Right-click and select "Save to Lion Reader"

## Configuration

Click the extension icon and select "Settings" (or right-click the icon and choose "Options") to:

- Set a custom server URL for self-hosted instances
- View and customize keyboard shortcuts

## How It Works

When you save a page, the extension:

1. Captures the current page's HTML content from the browser DOM
2. Sends the URL, HTML, and title to Lion Reader's API
3. Lion Reader extracts and cleans the article content

This approach allows saving authenticated content that the server couldn't fetch directly.

## Privacy

- The extension only activates when you explicitly save a page
- Page content is sent directly to your Lion Reader server
- No data is sent to any third parties
- For self-hosted instances, all data stays on your server

## Development

The extension structure:

```
extension/
├── manifest.json      # Extension manifest (MV3)
├── icons/             # Extension icons
└── src/
    ├── popup.html     # Popup UI
    ├── popup.js       # Popup logic
    ├── background.js  # Service worker (context menu, shortcuts)
    ├── options.html   # Settings page
    └── options.js     # Settings logic
```

No build step is required - the extension runs directly from source.

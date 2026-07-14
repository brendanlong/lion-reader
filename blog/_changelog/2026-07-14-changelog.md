---
title: "Changelog: week of July 14, 2026"
date: 2026-07-14
author: Lion Reader
---

- **Redesigned visual style**: Rolled out a warm amber accent color across buttons, links, and highlights, with clearer keyboard focus rings, more legible warning/success banners, better read/unread and star-button contrast, a new "danger" button style for destructive actions, and tabular figures for numbers (unread counts, stats, narration). Also fixed the mobile PWA status bar to track the app theme instead of a fixed orange, and fixed UI text falling back to Arial instead of the intended font. ([#1184](https://github.com/brendanlong/lion-reader/pull/1184), [#1189](https://github.com/brendanlong/lion-reader/pull/1189), [#1198](https://github.com/brendanlong/lion-reader/pull/1198), [#1173](https://github.com/brendanlong/lion-reader/pull/1173))
- **New list density option**: Added a compact/comfortable setting for the entry list ([#1176](https://github.com/brendanlong/lion-reader/pull/1176)).
- **YouTube videos now embed inline**: YouTube feed entries render as playable embedded videos in the reader ([#1137](https://github.com/brendanlong/lion-reader/pull/1137)), and saved YouTube videos now get a proper embed and description ([#1167](https://github.com/brendanlong/lion-reader/pull/1167)).
- **New Bluesky plugin**: Bluesky subscriptions now hydrate full post content by default instead of showing truncated embeds ([#1180](https://github.com/brendanlong/lion-reader/pull/1180)).
- **New e-paper theme**: Added a high-contrast theme mode designed for e-ink screens ([#1149](https://github.com/brendanlong/lion-reader/pull/1149)).
- **Discord bot improvements**: You can now save URLs by sending or forwarding them directly to the bot in a DM, and fixed a bug where DMs sent right after the bot restarted could be missed ([#1207](https://github.com/brendanlong/lion-reader/pull/1207), [#1208](https://github.com/brendanlong/lion-reader/pull/1208)).
- **Narration fixes**: Narration now reads the content variant you're actually viewing, and fixed audio/text highlight desync on articles formatted with double line breaks ([#1206](https://github.com/brendanlong/lion-reader/pull/1206)).
- **Cleaner summary model names**: AI summary model names now display in a readable title-case format (e.g. "Claude Sonnet 5.0") ([#1205](https://github.com/brendanlong/lion-reader/pull/1205)).
- **Save private Google Docs**: You can now save private Google Docs via the Wallabag/MCP compatible APIs, and saving an unreachable URL now returns a clear error instead of a generic failure ([#1166](https://github.com/brendanlong/lion-reader/pull/1166), [#1161](https://github.com/brendanlong/lion-reader/pull/1161)).
- **Google Reader API**: Saved articles are now exposed through the Google Reader-compatible API for third-party reader apps ([#1068](https://github.com/brendanlong/lion-reader/pull/1068)).
- **Subscription reliability fixes**: Fixed a bug where new subscriptions could show stale/missing entries right after subscribing, and fixed feed renewals that could get stuck in a "pending" state forever ([#1183](https://github.com/brendanlong/lion-reader/pull/1183), [#1096](https://github.com/brendanlong/lion-reader/pull/1096)).

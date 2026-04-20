---
title: "Changelog: week of April 20, 2026"
date: 2026-04-20
author: Lion Reader
---

- **Fixed the unread-only filter cutting off your subscription list** — when filtering to show only feeds with unread articles, all matching subscriptions now load correctly instead of being truncated ([#822](https://github.com/brendanlong/lion-reader/pull/822))
- **Fixed markdown articles with colons in their metadata** — posts whose frontmatter values contained colons (e.g. in titles or URLs) were previously not parsed correctly ([#819](https://github.com/brendanlong/lion-reader/pull/819))
- **Fixed a crash during AI score model training** — the background worker no longer runs out of memory when learning your reading preferences ([#801](https://github.com/brendanlong/lion-reader/pull/801))

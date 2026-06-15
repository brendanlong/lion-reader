---
title: "Changelog: week of June 15, 2026"
date: 2026-06-15
author: Lion Reader
---

- Fixed a critical outage where all feeds were failing with "Unknown feed format" — feeds should now fetch and update normally again ([#904](https://github.com/brendanlong/lion-reader/pull/904))
- Fixed stale unread counts on collapsed tag badges in the sidebar ([#894](https://github.com/brendanlong/lion-reader/pull/894)), and resolved duplicate or incorrect unread counts appearing in tag and uncategorized views
- Fixed a bug where catch-up sync could apply updates twice after reconnecting, causing read/unread state to get out of sync ([#898](https://github.com/brendanlong/lion-reader/pull/898))
- Improved real-time update reliability and reduced server overhead by sharing a single Redis subscriber connection across all live clients ([#895](https://github.com/brendanlong/lion-reader/pull/895))
- Improved tag list loading performance with a more efficient database query ([#900](https://github.com/brendanlong/lion-reader/pull/900))
- OAuth loopback redirect URIs (used by native apps) now correctly accept any port, per the RFC 8252 standard ([#903](https://github.com/brendanlong/lion-reader/pull/903))

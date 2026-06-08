---
title: "Changelog: week of June 8, 2026"
date: 2026-06-08
author: Lion Reader
---

- Fixed a bug where entry pages could return a blank error page (streamed 500) in production ([#881](https://github.com/brendanlong/lion-reader/pull/881))
- Improved timeline loading performance with a new composite database index for filtering and sorting ([#880](https://github.com/brendanlong/lion-reader/pull/880))
- Tightened API token security: OAuth tokens and API keys now have their scopes and audience properly enforced ([#882](https://github.com/brendanlong/lion-reader/pull/882))

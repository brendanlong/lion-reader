---
title: "Changelog: week of April 4, 2026"
date: 2026-04-04
author: Lion Reader
---

Here's what's new in Lion Reader since the last update:

- **Screen stays on during narration** — the display no longer dims or locks while an article is being read aloud ([#762](https://github.com/brendanlong/lion-reader/pull/762))
- **Fixed the "Recently Read" list** — articles now appear reliably as you read them, and only actually-read articles are shown ([#748](https://github.com/brendanlong/lion-reader/pull/748), [#750](https://github.com/brendanlong/lion-reader/pull/750))
- **Fixed swipe gesture false positives** ([#745](https://github.com/brendanlong/lion-reader/pull/745)) — accidental swipes should trigger much less often
- **Fixed article timestamps** showing "0 years ago" for posts near the one-year mark ([#753](https://github.com/brendanlong/lion-reader/pull/753))
- **Fixed email subscriptions** not appearing correctly in your subscription list ([#751](https://github.com/brendanlong/lion-reader/pull/751))
- **Improved article scoring** — saved articles now correctly take priority, and unread articles are excluded from personalization model training ([#733](https://github.com/brendanlong/lion-reader/pull/733), [#752](https://github.com/brendanlong/lion-reader/pull/752))
- **Launched an announcements blog** with an RSS feed you can follow for release notes and updates — [announcements.lionreader.com](https://announcements.lionreader.com) ([feed](https://announcements.lionreader.com/feed.xml))
- **Added a changelog RSS feed** so you can subscribe to these release notes directly ([changelog.xml](https://announcements.lionreader.com/changelog.xml))

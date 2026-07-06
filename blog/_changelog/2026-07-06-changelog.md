---
title: "Changelog: week of July 6, 2026"
date: 2026-07-06
author: Lion Reader
---

Here's a summary of what's new since the last changelog post:

- **Improved real-time updates**: New entries now appear in your reading list live via server-sent events, and entries you mark as unread are immediately restored to unread-only views — no manual refresh needed ([#965](https://github.com/brendanlong/lion-reader/pull/965), [#966](https://github.com/brendanlong/lion-reader/pull/966))
- **Fixed unread counts**: Corrected an over-count in global unread totals, and fixed stale sidebar counts when marking a feed's last unread entry as read ([#1000](https://github.com/brendanlong/lion-reader/pull/1000), [#958](https://github.com/brendanlong/lion-reader/pull/958))
- **Improved touch targets**: The read/unread dot is now a larger 44px touch target, and the star button's touch area has been enlarged — easier to tap on mobile ([#1005](https://github.com/brendanlong/lion-reader/pull/1005), [#1009](https://github.com/brendanlong/lion-reader/pull/1009))
- **Better error pages**: Subscription and tag views now show a proper "not found" message for missing feeds instead of a generic error ([#1007](https://github.com/brendanlong/lion-reader/pull/1007))
- **Math rendering**: Articles containing MathJax math are now rendered as proper MathML ([#940](https://github.com/brendanlong/lion-reader/pull/940))
- **Upgraded default summary model**: AI summaries now use claude-sonnet-5 by default ([#949](https://github.com/brendanlong/lion-reader/pull/949))
- **Fixed the claude.ai MCP connector**: Resolved several OAuth and configuration issues that were preventing the claude.ai web connector from working ([#974](https://github.com/brendanlong/lion-reader/pull/974), [#977](https://github.com/brendanlong/lion-reader/pull/977), [#978](https://github.com/brendanlong/lion-reader/pull/978))
- **Improved swipe navigation**: Pinch-to-zoom and mid-pan gestures no longer accidentally trigger article navigation ([#980](https://github.com/brendanlong/lion-reader/pull/980))
- **UI polish**: The OPML upload button has been moved to the header, and primary button colors have been softened for better contrast ([#1010](https://github.com/brendanlong/lion-reader/pull/1010))
- **Smarter summarization re-triggering**: Changes to the max word count or custom prompt settings now correctly trigger a re-summarization ([#996](https://github.com/brendanlong/lion-reader/pull/996))
- **Better handling of rate-limited feeds**: Sites that return HTTP 429 (rate limited) are now treated differently from sites that are blocking the reader ([#858](https://github.com/brendanlong/lion-reader/pull/858))

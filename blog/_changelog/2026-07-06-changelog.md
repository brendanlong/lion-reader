---
title: "Changelog: week of July 6, 2026"
date: 2026-07-06
author: Lion Reader
---

Here's a summary of what's new since the last changelog post:

- **Improved real-time updates**: New entries now appear in your reading list live via server-sent events — no refresh needed ([#965](https://github.com/brendanlong/lion-reader/pull/965))
- **Math rendering**: Articles containing MathJax math are now rendered as proper MathML ([#940](https://github.com/brendanlong/lion-reader/pull/940))
- **Improved swipe navigation**: Pinch-to-zoom and mid-pan gestures no longer accidentally trigger article navigation ([#980](https://github.com/brendanlong/lion-reader/pull/980))
- **Improved touch targets**: The read/unread dot is now a larger 44px touch target, and the star button's touch area has been enlarged — easier to tap on mobile ([#1005](https://github.com/brendanlong/lion-reader/pull/1005), [#1009](https://github.com/brendanlong/lion-reader/pull/1009))
- **Fixed unread counts**: Corrected an over-count in global unread totals, and fixed stale sidebar counts when marking a feed's last unread entry as read ([#1000](https://github.com/brendanlong/lion-reader/pull/1000), [#958](https://github.com/brendanlong/lion-reader/pull/958))
- **UI polish**: The saved article upload button has been moved to the header, and primary button colors have been softened for better contrast ([#1010](https://github.com/brendanlong/lion-reader/pull/1010))
- **Better error pages**: Subscription and tag views now show a proper "not found" message for missing feeds instead of a generic error ([#1007](https://github.com/brendanlong/lion-reader/pull/1007))
- **Upgraded default summary model**: AI summaries now use claude-sonnet-5 by default ([#949](https://github.com/brendanlong/lion-reader/pull/949))
- **Smarter summarization re-triggering**: Changes to the max word count or custom prompt settings now correctly allow for re-summarization ([#996](https://github.com/brendanlong/lion-reader/pull/996))
- **MCP connector improvements**: Resolved several OAuth and configuration issues to broaden MCP connector support ([#974](https://github.com/brendanlong/lion-reader/pull/974), [#977](https://github.com/brendanlong/lion-reader/pull/977), [#978](https://github.com/brendanlong/lion-reader/pull/978)), although unfortunately claude.ai is still broken due to upstream issues ([claude-ai-mcp#546](https://github.com/anthropics/claude-ai-mcp/issues/546))
- **Better handling of rate-limited feeds**: Sites that return HTTP 429 (rate limited) are now treated differently from sites that are blocking the reader ([#858](https://github.com/brendanlong/lion-reader/pull/858))

---
title: "Summer Updates: App Compatibility, Performance, and a Style Refresh"
date: 2026-07-14
author: Brendan Long
---

It's been a few months since the last announcement, and a lot has shipped since then. Here are the highlights.

## Google Reader and Wallabag API fixes

If you tried using a third-party app with Lion Reader before and hit sync problems, it's worth another look. We spent a lot of time testing against real apps ([FeedMe](https://play.google.com/store/apps/details?id=com.seazon.feedme), [Newsflash](https://apps.gnome.org/NewsFlash/), [Read You](https://github.com/Ashinch/ReadYou), and others) and fixed every incompatibility we found in the [Google Reader API](https://lionreader.com/demo/all?entry=google-reader-api):

- Fixed Read You syncing zero articles (a continuation-cursor encoding bug)
- Fixed Newsflash setup and FeedMe login
- Much faster sync for large accounts
- Your [saved articles](https://lionreader.com/demo/all?entry=save-for-later) now show up in Google Reader apps too
- You can now import subscriptions (including OPML files) through the API

The [Wallabag API](https://lionreader.com/demo/all?entry=wallabag-api) got the same treatment: proper incremental sync and pagination, sorting and domain filters, fixes for archive/star/delete in some clients, and clearer errors when something goes wrong. You can even save private Google Docs through it now.

## Performance and real-time updates

Lion Reader was already fast, but it's noticeably faster now, and it updates live:

- **[Real-time updates](https://lionreader.com/demo/all?entry=real-time)**: new articles now appear in your lists the moment they're fetched — no refresh needed. Read and star changes from other devices show up instantly too, and nothing ever jumps around while you're reading.
- **[Faster everything](https://lionreader.com/demo/all?entry=performance)**: articles are now cleaned and formatted once on the server instead of every time you open them, timeline queries use a new database index, and navigating between articles you've already loaded is instant with no loading flicker.
- Lots of unread-count bugs are fixed — counts now stay in sync across tabs, tags, and merged feeds.

## Cleaned-up styles and an e-paper mode

The whole interface got a visual refresh: a warm amber accent color, better contrast for read/unread states and buttons, clearer keyboard focus indicators, and a new compact density option for the entry list.

There's also a new **e-paper theme** built for e-ink devices like Kindles, Kobos, and Onyx Boox readers — pure white background, high contrast, and colors that stay readable in grayscale. With your theme set to Auto, Lion Reader will even detect e-readers and switch automatically. See [Appearance & Themes](https://lionreader.com/demo/all?entry=appearance) for the full set of options.

## Other highlights

- **YouTube feeds** now render as playable inline videos
- **New Bluesky plugin** fetches full post content instead of truncated embeds
- **Math rendering**: articles with MathJax equations now render them natively as MathML
- **[Discord bot](https://lionreader.com/demo/all?entry=discord-bot)**: save articles by DMing or forwarding a link to the bot
- **Lion Reader is now MIT licensed** — the full source is at [github.com/brendanlong/lion-reader](https://github.com/brendanlong/lion-reader)

As always, this feed only gets major announcements. For weekly detailed updates, subscribe to the [GitHub releases feed](https://github.com/brendanlong/lion-reader/releases.atom), and please [report bugs or feature requests on GitHub](https://github.com/brendanlong/lion-reader/issues) or [email me](mailto:self@brendanlong.com).

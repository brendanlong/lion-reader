---
title: "A Faster Database, Search Is Back, and Bring-Your-Own AI"
date: 2026-07-18
author: Brendan Long
---

Three updates went out today, all aimed at making Lion Reader faster and more flexible.

## A much faster database

Lion Reader's database now runs on a much faster host. If you ran into occasional slowness before — lists taking a beat to load, an action hanging for a moment — that should be gone now. Sorry for the brief downtime while we moved it over this morning.

The move also means we can scale the database up almost instantly from here on. If we ever need a bigger, faster machine, it won't take the kind of downtime it used to.

## Full-text search is back

Directly on the back of that faster database, we've **re-enabled [full-text search](https://lionreader.com/demo/all?entry=search)**. Press <strong>/</strong> or tap the search icon and start typing — Lion Reader searches every article in your archive by title and full text, and results come back near-instantly with the closest matches first.

Search understands word variations (a search for "cook" also finds "cooking" and "cooked"), keeps whatever view you're already in — a subscription, a [tag](https://lionreader.com/demo/all?entry=tags), your [saved articles](https://lionreader.com/demo/all?entry=save-for-later), or starred items — and works everywhere you read, including through AI assistants via the [MCP server](https://lionreader.com/demo/all?entry=mcp-server).

## Bring your own AI model

We rebuilt the AI backend so it's no longer tied to a single provider. If you add an API key, you can now pick **any Groq, Anthropic, or Cerebras model for [summaries](https://lionreader.com/demo/all?entry=ai-summaries)**, and **any Groq or Cerebras model for [narration](https://lionreader.com/demo/all?entry=text-to-speech) cleanup** (the text preprocessing that makes articles sound natural when read aloud). Set your keys and preferred models under Settings → AI &amp; Narration.

Our recommendation for most people is **[GPT-OSS-120B](https://openai.com/index/introducing-gpt-oss/) on [Cerebras](https://www.cerebras.ai/)**: summaries come back near-instantly, at roughly a tenth of the price of Claude Sonnet. It's not quite as sharp as Claude for the trickiest articles, but for triaging a reading list the speed and price are hard to beat. [Groq](https://groq.com/) offers some cheaper options too, though their paid tier looks to be waitlisted at the moment. And if you'd rather have the smartest possible summaries, [Anthropic's Claude](https://www.anthropic.com/) models are still there.

As always, summaries and narration are only generated when you ask for them, and results are cached and shared across users so you rarely pay for the same article twice.

---

This feed only gets major announcements. For weekly detailed updates, subscribe to the [GitHub releases feed](https://github.com/brendanlong/lion-reader/releases.atom), and please [report bugs or feature requests on GitHub](https://github.com/brendanlong/lion-reader/issues) or [email me](mailto:self@brendanlong.com).

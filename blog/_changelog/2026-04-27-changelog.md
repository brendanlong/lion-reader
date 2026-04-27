---
title: "Changelog: week of April 27, 2026"
date: 2026-04-27
author: Lion Reader
---

Made several security improvements to protect your account and data:

- **Hardened authentication and API security** — Added rate limiting to sign-in and token endpoints to help protect against brute-force attacks, fixed a race condition that could accidentally lock you out of your account when unlinking a login provider ([#825](https://github.com/brendanlong/lion-reader/pull/825)), and stopped storing decrypted API keys in the session cache ([#834](https://github.com/brendanlong/lion-reader/pull/834))

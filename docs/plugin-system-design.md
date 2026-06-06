# URL Plugin System Design

This document explains _why_ the plugin system is shaped the way it is. For the
actual interfaces and implementations, follow the links to the source — the code
is the source of truth, this doc is the rationale.

## Overview

The plugin system consolidates per-source custom parsing logic (feeds, saved
articles) behind a single capability-based interface, so adding a new content
source means writing a self-contained plugin instead of scattering
`isLessWrongUrl()` / `isGoogleDocsUrl()` branches across core modules.

Source: [`src/server/plugins/`](../src/server/plugins/)

- [`types.ts`](../src/server/plugins/types.ts) — `UrlPlugin`, `PluginCapabilities`, capability interfaces
- [`registry.ts`](../src/server/plugins/registry.ts) — hostname-indexed registry
- [`index.ts`](../src/server/plugins/index.ts) — plugin registration + `getFeedPlugin` helper
- Plugins: [`lesswrong.ts`](../src/server/plugins/lesswrong.ts), [`google-docs.ts`](../src/server/plugins/google-docs.ts), [`arxiv.ts`](../src/server/plugins/arxiv.ts), [`github.ts`](../src/server/plugins/github.ts)

## Design rationale

### Hostname-indexed lookup, then `matchUrl`

The registry indexes plugins by hostname for O(1) lookup, then calls the
plugin's `matchUrl(url)` to confirm it handles that specific URL shape.

**`matchUrl` must be selective, not "any URL on my hosts".** A plugin should only
match URLs it actually knows how to handle. For example, LessWrong has pages we
can't map to its GraphQL API or to a feed (e.g. `/tag/...`, `/library`); those
must return `false` so the caller falls back to normal fetching. Matching too
eagerly and relying on the capability function to return `null` works for the
saved-article fallback, but it's surprising and couples unrelated capabilities —
prefer a precise `matchUrl`.

### Capability-based lookup

`registry.findWithCapability(url, capability)` returns the first plugin that both
matches the URL _and_ declares the requested capability. This keeps the two
halves independent: a plugin can provide `feed` handling, `savedArticle`
handling, or both.

- **`feed`** — operates on feeds and feed-mappable pages: `transformToFeedUrl`
  (page → RSS feed), `cleanEntryContent` (strip source-specific cruft),
  `transformFeedTitle` (e.g. append the author to a user-profile feed).
- **`savedArticle`** — fetches full article content for read-it-later, optionally
  skipping Readability when the source already returns clean HTML.

### `transformFeedTitle` is synchronous

It takes the already-parsed feed data via `FeedTitleContext` (currently
`firstAuthor`) rather than doing its own network lookup. Feed processing is a hot
path, so we reuse data we already parsed instead of making a GraphQL round-trip.
`context` is optional/defaulted so callers without parsed entries can still call it.

### Graceful fallback

If a capability function returns `null` or throws, callers fall back to normal
fetching/processing. Plugins are an optimization layer, never a hard dependency.

## Integration points

All of these resolve a plugin from the registry and call into a capability;
there are no hardcoded per-source branches in the core modules anymore.

| Concern                     | Where                                                                                                                          | Capability used                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Saved-article full content  | [`services/full-content.ts`](../src/server/services/full-content.ts), [`services/saved.ts`](../src/server/services/saved.ts)   | `savedArticle.fetchContent` / `skipReadability` |
| Feed entry content cleaning | [`feed/content-utils.ts`](../src/server/feed/content-utils.ts), [`trpc/routers/feeds.ts`](../src/server/trpc/routers/feeds.ts) | `feed.cleanEntryContent`                        |
| Feed title transform        | [`jobs/handlers.ts`](../src/server/jobs/handlers.ts), [`trpc/routers/feeds.ts`](../src/server/trpc/routers/feeds.ts)           | `feed.transformFeedTitle`                       |
| Page-URL → feed-URL         | [`trpc/routers/feeds.ts`](../src/server/trpc/routers/feeds.ts)                                                                 | `feed.transformToFeedUrl`                       |

`getFeedPlugin(url)` (in [`plugins/index.ts`](../src/server/plugins/index.ts)) is
the convenience resolver for the feed-side call sites: it parses a URL string
(returning `null` for invalid URLs or unhandled hosts) and looks up the
feed-capable plugin.

## Testing strategy

- **Unit tests** (pure logic): `matchUrl` selectivity, `cleanEntryContent`,
  `transformFeedTitle`, and the pure branches of `transformToFeedUrl` — see
  [`tests/unit/lesswrong-plugin.test.ts`](../tests/unit/lesswrong-plugin.test.ts).
- **Integration tests** (real DB / mocked HTTP): full saved-article and
  feed-processing flows that exercise the plugin path end to end.

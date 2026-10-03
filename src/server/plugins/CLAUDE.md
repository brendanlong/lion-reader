# Content-Source Plugins (`src/server/plugins/`)

Interfaces are in `types.ts`, registration in `index.ts`; each plugin file documents its own source.

- **`matchUrl` is selective**: match only URLs the plugin can actually handle (LessWrong `/tag/...` pages return `false` so the caller falls back to normal fetching). A `*.example.com` host matches every subdomain but not the bare domain.
- **Claim only what you positively recognize.** A plugin that scrapes a page (LinkedIn, Threads) or claims an already-fetched one (`fetchContentFromPage`, e.g. Notion on a customer's own domain) matches a type or marker the document itself declares, never whichever field looks like a body, and returns null otherwise. With `skipReadability` nothing downstream re-checks the extraction, so a guess is stored silently; declining only costs a fallback.
- `fetchContentFromPage` runs after the generic fetch on every save/full-content fetch no hostname-matched plugin handled, so it must decline cheaply.
- **Before writing a scraping plugin, measure what the generic path already produces**, and record that measurement and the source's `robots.txt` constraints in the plugin file.
- Fetch through `fetchWithSsrfProtection` even for hardcoded hosts (SECURITY.md §2).

/**
 * Full Content Fetching Service
 *
 * Fetches and extracts full article content from URLs using Readability.
 * Attempts to use plugins (LessWrong GraphQL, Google Docs API, etc.) first,
 * then falls back to standard HTML fetching and Readability.
 */

import { createHash } from "crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { entries, narrationContent, subscriptions } from "@/server/db/schema";
import { fetchHtmlPage, HttpFetchError } from "@/server/http/fetch";
import { cleanContent, cleanContentAsync, absolutizeUrls } from "@/server/feed/content-cleaner";
import { sanitizeEntryContentFamily } from "@/server/html/sanitize-entry";
import { pluginRegistry, claimFetchedPage } from "@/server/plugins";
import type { SavedArticleContent } from "@/server/plugins/types";
import { logger } from "@/lib/logger";
import { processMarkdown } from "@/server/markdown";
import { errors } from "@/server/trpc/errors";
import { selectFullEntry, toFullEntry } from "./entries";

/**
 * Result of fetching full article content.
 */
export interface FetchFullContentResult {
  /** Whether the fetch was successful */
  success: boolean;
  /** The raw HTML content from the URL */
  contentOriginal?: string;
  /** The Readability-cleaned HTML content */
  contentCleaned?: string;
  /** Error message if the fetch failed */
  error?: string;
}

/**
 * Fetches full article content from a URL.
 *
 * This function:
 * 1. Checks if there's a plugin that can handle the URL (LessWrong GraphQL, etc.)
 * 2. Falls back to standard HTML fetching + Readability if no plugin matches
 * 3. Returns both the original HTML and the cleaned content
 *
 * @param url - The article URL to fetch
 * @param options.offloadClean - Run the content-cleaning pass (Readability, or
 *   Markdown rendering when the URL served Markdown) on the libuv thread pool
 *   instead of inline on the calling thread. On by default; the background feed
 *   worker passes false because it already runs off the request path, so the
 *   async hop is pure overhead. App-server callers (fetchAndStoreFullContent)
 *   keep the default so the pass never stalls the UI-serving event loop.
 * @returns The fetch result with content or error
 */
export async function fetchFullContent(
  url: string,
  options: { offloadClean?: boolean } = {}
): Promise<FetchFullContentResult> {
  const { offloadClean = true } = options;
  // Run extraction either on the libuv thread pool or inline, per offloadClean.
  const runClean = (html: string, resolveUrl: string): Promise<{ content: string } | null> =>
    offloadClean
      ? cleanContentAsync(html, { url: resolveUrl })
      : Promise.resolve(cleanContent(html, { url: resolveUrl }));

  // Plugin content is already the article: store it as the original and run
  // Readability only if the plugin didn't declare it clean.
  const resultFromPlugin = async (
    pluginContent: SavedArticleContent,
    skipReadability: boolean | undefined,
    fallbackResolveUrl: string
  ): Promise<FetchFullContentResult> => {
    const html = pluginContent.html;
    const resolveUrl = pluginContent.canonicalUrl || fallbackResolveUrl;
    const contentOriginal = absolutizeUrls(html, resolveUrl);
    if (skipReadability) {
      return { success: true, contentOriginal };
    }
    const cleaned = await runClean(html, resolveUrl);
    return { success: true, contentOriginal, contentCleaned: cleaned?.content };
  };

  try {
    const urlObj = new URL(url);

    // Check if there's a plugin that can handle this URL
    const plugin = pluginRegistry.findWithCapability(urlObj, "savedArticle");

    if (plugin) {
      logger.debug("Using plugin for full content fetch", {
        url,
        plugin: plugin.name,
      });

      try {
        const pluginContent = await plugin.capabilities.savedArticle.fetchContent(urlObj);

        if (pluginContent) {
          logger.debug("Plugin successfully fetched content", {
            url,
            plugin: plugin.name,
          });
          return await resultFromPlugin(
            pluginContent,
            plugin.capabilities.savedArticle.skipReadability,
            url
          );
        }
      } catch (error) {
        logger.warn("Plugin fetch failed, falling back to standard fetching", {
          url,
          plugin: plugin.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fall back to standard HTML fetching + Readability
    logger.debug("Fetching full content using standard method", { url });

    const result = await fetchHtmlPage(url);
    const resolveUrl = result.finalUrl;

    // We request HTML, not Markdown (#1280), so this is a fallback: a server
    // returned Markdown anyway (e.g. a raw `.md` URL). Convert it to HTML and
    // skip Readability — a markdown-only endpoint's body is the content itself,
    // and once flattened to markdown the DOM structure Readability needs to
    // separate chrome from content is already gone.
    if (result.isMarkdown) {
      logger.debug("Converting Markdown to HTML (skipping Readability)", { url });
      const { html } = await processMarkdown(result.content, {
        offload: offloadClean,
      });

      // Readability is what absolutizes on the other branches, and it didn't
      // run here — neither the Markdown renderer nor the sanitizer resolves
      // relative URLs, so do it once and store the same copy in both fields.
      // Markdown has no "original" HTML distinct from the rendered output, and
      // the cleaned copy is the one that gets displayed.
      const content = absolutizeUrls(html, resolveUrl);

      return {
        success: true,
        contentOriginal: content,
        contentCleaned: content,
      };
    }

    // A page no hostname-matched plugin handled may still be a source a plugin
    // recognizes from the document itself (a Notion page on a custom domain).
    if (!plugin) {
      const claimed = await claimFetchedPage({ html: result.content, url: new URL(resolveUrl) });
      if (claimed) {
        logger.debug("Plugin claimed the fetched page", { url, plugin: claimed.plugin.name });
        return await resultFromPlugin(
          claimed.content,
          claimed.plugin.capabilities.savedArticle.skipReadability,
          resolveUrl
        );
      }
    }

    // For HTML, absolutize URLs in the original
    const html = result.content;
    const contentOriginal = absolutizeUrls(html, resolveUrl);

    // Clean the content using Readability
    const cleaned = await runClean(html, resolveUrl);

    if (!cleaned) {
      return {
        success: false,
        error: "Could not extract article content from page",
      };
    }

    return {
      success: true,
      contentOriginal,
      contentCleaned: cleaned.content,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.warn("Failed to fetch full content", { url, error: errorMessage });

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Persist a fetchFullContent result onto an entry's full-content columns.
 *
 * This is the single write site for the full-content invariants — hash
 * derivation for summary caching and error persistence — shared by the
 * user-initiated fetch (fetchAndStoreFullContent) and the background worker
 * (fetchFullContentForNewEntries below).
 *
 * Stores only the raw full-content columns; the read path sanitizes per read
 * (issue #1282).
 *
 * @returns the applied update (the raw full-content columns) on success, or null
 *   when the fetch failed and only the error was persisted.
 */
async function persistFullContentResult(
  db: typeof dbType,
  entryId: string,
  result: FetchFullContentResult,
  now: Date = new Date()
) {
  if (!result.success) {
    await db
      .update(entries)
      .set({
        fullContentError: result.error ?? "Unknown error",
        fullContentFetchedAt: now,
        updatedAt: now,
      })
      .where(eq(entries.id, entryId));
    return null;
  }

  // Compute hash of full content for separate summary caching
  const fullContentForHash = result.contentCleaned ?? result.contentOriginal ?? "";
  const fullContentHash = fullContentForHash
    ? createHash("sha256").update(fullContentForHash, "utf8").digest("hex")
    : null;

  const fullContentUpdate = {
    fullContentOriginal: result.contentOriginal ?? null,
    fullContentCleaned: result.contentCleaned ?? null,
    fullContentHash,
    fullContentFetchedAt: now,
    fullContentError: null,
    updatedAt: now,
  };

  await db.update(entries).set(fullContentUpdate).where(eq(entries.id, entryId));
  return fullContentUpdate;
}

/**
 * Maximum number of entries to fetch full content for per call to
 * {@link fetchFullContentForNewEntries} (one poll, or one WebSub push). The
 * fetches run sequentially inside a single job, so this bounds how long that job
 * holds a worker slot and how hard one burst of new entries hits the origin.
 */
const MAX_FULL_CONTENT_ENTRIES_PER_BATCH = 10;

/**
 * Whether any active subscriber of the feed has `fetch_full_content` on. Full
 * content lives on the shared entry row, so one such subscriber is enough.
 */
export async function feedWantsFullContent(db: typeof dbType, feedId: string): Promise<boolean> {
  const rows = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.feedId, feedId),
        isNull(subscriptions.unsubscribedAt),
        eq(subscriptions.fetchFullContent, true)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Fetches and stores full content for a feed's newly-arrived entries, if any
 * active subscriber has `fetch_full_content` enabled.
 *
 * The single background path for "fetch full content" subscriptions, however an
 * entry arrived: a poll calls it inline from the `fetch_feed` job, and a WebSub
 * push (which is ingested in the hub's callback request, where slow article
 * fetches must not run) defers it to a `fetch_full_content` job. Callers pass
 * only genuinely new entries — not archive re-announcements (`isBackfill`),
 * which must not spend the per-batch budget the real news needs.
 *
 * Runs Readability inline (`offloadClean: false`): it only runs on the worker,
 * off the request path, where the thread-pool hop is pure overhead.
 */
export async function fetchFullContentForNewEntries(
  db: typeof dbType,
  feedId: string,
  newEntryIds: string[]
): Promise<{ fetched: number; failed: number }> {
  if (newEntryIds.length === 0 || !(await feedWantsFullContent(db, feedId))) {
    return { fetched: 0, failed: 0 };
  }

  logger.debug("Full content fetching enabled for feed", {
    feedId,
    newEntryCount: newEntryIds.length,
  });

  const entriesToFetch = await db
    .select({ id: entries.id, url: entries.url })
    .from(entries)
    .where(
      and(
        inArray(entries.id, newEntryIds.slice(0, MAX_FULL_CONTENT_ENTRIES_PER_BATCH)),
        // Scoped to the feed so a caller can't reach another feed's entries.
        eq(entries.feedId, feedId)
      )
    );

  let fetched = 0;
  let failed = 0;
  let attempted = 0;

  // Sequential, to avoid overwhelming the origin.
  for (const entry of entriesToFetch) {
    if (entry.url === null) {
      continue;
    }
    attempted++;
    try {
      const result = await fetchFullContent(entry.url, { offloadClean: false });
      // Persists the raw full-content columns or the fetch error onto the shared
      // entry row; sanitization happens per read (issue #1282).
      const update = await persistFullContentResult(db, entry.id, result, new Date());

      if (update) {
        fetched++;
        logger.debug("Fetched full content for entry", { entryId: entry.id, url: entry.url });
      } else {
        failed++;
        logger.debug("Failed to fetch full content for entry", {
          entryId: entry.id,
          url: entry.url,
          error: result.error,
        });
      }
    } catch (error) {
      failed++;
      logger.warn("Error fetching full content for entry", {
        entryId: entry.id,
        url: entry.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (attempted > 0) {
    logger.info("Full content fetching completed", { feedId, fetched, failed, total: attempted });
  }

  return { fetched, failed };
}

/**
 * Full entry shape returned by fetchAndStoreFullContent (the toFullEntry
 * output shape used by entries.get).
 */
type FullEntry = Awaited<ReturnType<typeof toFullEntry>>;

export interface FetchAndStoreFullContentResult {
  success: boolean;
  entry?: FullEntry;
  error?: string;
}

/**
 * Fetches full article content for an entry and persists it.
 *
 * Verifies the entry is visible to the user, fetches the full article from
 * its URL (via fetchFullContent above), sanitizes and stores the result in
 * the entry's full-content columns, and invalidates any cached narration so
 * it is regenerated from the full content.
 *
 * Note on shared state: full-content columns (including `fullContentError`)
 * live on the shared `entries` row, so one subscriber's fetch — success or
 * failure — is visible to every subscriber of the feed. This is deliberate:
 * the fetched article and its fetchability are properties of the source URL,
 * not of the requesting user, and sharing the result means other subscribers
 * don't re-fetch (or re-fail) the same URL.
 *
 * @throws entryNotFound if the entry doesn't exist or isn't visible to the user
 */
export async function fetchAndStoreFullContent(
  db: typeof dbType,
  userId: string,
  entryId: string
): Promise<FetchAndStoreFullContentResult> {
  // Verify the entry exists and the user has access
  const rawEntry = await selectFullEntry(db, userId, entryId);
  if (!rawEntry) {
    throw errors.entryNotFound();
  }

  const contentHash = rawEntry.contentHash;

  // Check if entry has a URL to fetch (before building the response entry —
  // toFullEntry resolves sanitized content, which is wasted work here)
  if (!rawEntry.url) {
    return {
      success: false,
      error: "Entry has no URL to fetch content from",
    };
  }

  const entry = await toFullEntry(rawEntry);

  logger.info("Fetching full content for entry", {
    entryId: entry.id,
    url: rawEntry.url,
  });

  const result = await fetchFullContent(rawEntry.url);
  const now = new Date();
  // Persist the raw full-content columns onto the shared entry row (see note
  // above); sanitized for the response below (per-read sanitization, #1282).
  const fullContentUpdate = await persistFullContentResult(db, entryId, result, now);

  if (!result.success || !fullContentUpdate) {
    logger.warn("Failed to fetch full content", {
      entryId: entry.id,
      url: rawEntry.url,
      error: result.error,
    });

    return {
      success: false,
      error: result.error,
      entry: {
        ...entry,
        fullContentError: result.error ?? "Unknown error",
        fullContentFetchedAt: now,
      },
    };
  }

  // Invalidate any existing narration content so it will be regenerated
  // using the full content next time narration is requested
  if (contentHash) {
    await db
      .update(narrationContent)
      .set({
        contentNarration: null,
        generatedAt: null,
        error: null,
        errorAt: null,
      })
      .where(eq(narrationContent.contentHash, contentHash));

    logger.debug("Invalidated narration content for entry", {
      entryId: entry.id,
      contentHash,
    });
  }

  logger.info("Successfully fetched full content for entry", {
    entryId: entry.id,
    url: rawEntry.url,
    contentLength: result.contentCleaned?.length,
  });

  // Sanitize the freshly-fetched full content for the response (raw is stored;
  // sanitization is per-read now — issue #1282).
  const fullContent = await sanitizeEntryContentFamily("fullContent", {
    original: fullContentUpdate.fullContentOriginal,
    cleaned: fullContentUpdate.fullContentCleaned,
  });

  return {
    success: true,
    entry: {
      ...entry,
      fullContentOriginal: fullContent.original,
      fullContentCleaned: fullContent.cleaned,
      fullContentFetchedAt: now,
      fullContentError: null,
    },
  };
}

/**
 * Extracts a user-friendly error message from an error object.
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof HttpFetchError) {
    if (error.isRateLimited()) {
      return "Site is temporarily rate limiting requests";
    }
    if (error.isBlocked()) {
      return "Site blocked the request";
    }
    return `HTTP ${error.status}: ${error.statusText}`;
  }

  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return "Request timed out";
    }
    return error.message;
  }

  return "Unknown error";
}

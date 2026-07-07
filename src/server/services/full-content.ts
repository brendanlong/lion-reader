/**
 * Full Content Fetching Service
 *
 * Fetches and extracts full article content from URLs using Readability.
 * Attempts to use plugins (LessWrong GraphQL, Google Docs API, etc.) first,
 * then falls back to standard HTML fetching and Readability.
 */

import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { entries, narrationContent } from "@/server/db/schema";
import { fetchHtmlPage, HttpFetchError } from "@/server/http/fetch";
import { cleanContent, absolutizeUrls } from "@/server/feed/content-cleaner";
import { cleanContentInWorker } from "@/server/worker-thread/pool";
import {
  withSanitizedEntryContent,
  withSanitizedEntryContentAsync,
} from "@/server/html/sanitize-entry";
import { pluginRegistry } from "@/server/plugins";
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
  /**
   * The sanitized form of `contentCleaned`, when Readability ran in the worker
   * pool with the sanitize fused in (offloadClean path). Persisted via
   * `persistFullContentResult` as a `presanitized` hint so the sanitize isn't
   * repeated. `undefined` when cleaning ran inline or no cleaned content exists.
   */
  contentCleanedSanitized?: string | null;
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
 * @param options.offloadClean - Run Readability in the worker-thread pool (with
 *   the cleaned-HTML sanitize fused in) instead of inline on the calling thread.
 *   On by default; the background feed worker passes false because it already
 *   runs off the request path, so the thread hop is pure overhead. App-server
 *   callers (fetchAndStoreFullContent) keep the default so the CPU-bound
 *   Readability pass never stalls the UI-serving event loop.
 * @returns The fetch result with content or error
 */
export async function fetchFullContent(
  url: string,
  options: { offloadClean?: boolean } = {}
): Promise<FetchFullContentResult> {
  const { offloadClean = true } = options;
  // Run Readability either in the worker pool (fusing the cleaned-HTML sanitize
  // so persistFullContentResult can reuse it) or inline, per offloadClean. The
  // inline path has no `contentSanitized` (only the worker fuses the sanitize).
  const runClean = (
    html: string,
    resolveUrl: string
  ): Promise<{ content: string; contentSanitized?: string | null } | null> =>
    offloadClean
      ? cleanContentInWorker(html, { url: resolveUrl }, { sanitizeCleaned: true })
      : Promise.resolve(cleanContent(html, { url: resolveUrl }));

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
        const pluginContent = await plugin.capabilities.savedArticle.fetchContent(urlObj, {});

        if (pluginContent) {
          logger.debug("Plugin successfully fetched content", {
            url,
            plugin: plugin.name,
          });

          const html = pluginContent.html;
          const resolveUrl = pluginContent.canonicalUrl || url;

          const contentOriginal = absolutizeUrls(html, resolveUrl);

          // Respect plugin's skipReadability setting
          if (plugin.capabilities.savedArticle.skipReadability) {
            return {
              success: true,
              contentOriginal,
            };
          }

          // Run Readability on plugin content
          const cleaned = await runClean(html, resolveUrl);

          return {
            success: true,
            contentOriginal,
            contentCleaned: cleaned?.content,
            contentCleanedSanitized: cleaned?.contentSanitized,
          };
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

    // If we got Markdown, convert it to HTML and skip Readability
    // Markdown is already clean content, no need for article extraction
    if (result.isMarkdown) {
      logger.debug("Converting Markdown to HTML (skipping Readability)", { url });
      const { html: contentCleaned } = await processMarkdown(result.content);

      // Absolutize URLs in the original HTML (before title stripping)
      const contentOriginal = absolutizeUrls(contentCleaned, resolveUrl);

      return {
        success: true,
        contentOriginal,
        contentCleaned,
      };
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
      contentCleanedSanitized: cleaned.contentSanitized,
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
 * derivation for summary caching, sanitized-column stamping via
 * withSanitizedEntryContent, and error persistence — shared by the
 * user-initiated fetch (fetchAndStoreFullContent) and the background worker
 * (fetchFullContentForEntries in jobs/handlers.ts).
 *
 * @returns the applied update (including the sanitized columns) on success,
 *   or null when the fetch failed and only the error was persisted.
 */
export async function persistFullContentResult(
  db: typeof dbType,
  entryId: string,
  result: FetchFullContentResult,
  now: Date = new Date(),
  // Offload sanitization to a worker thread for large bodies. On by default; the
  // background worker (fetchFullContentForEntries) passes false because it
  // already runs off the request path, so the extra thread hop is pure overhead.
  options: { offloadSanitize?: boolean } = {}
) {
  const { offloadSanitize = true } = options;
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

  // Sanitize the fetched full content once: stored in the *_sanitized columns
  // so reads are fast. The raw page HTML / Readability output is untrusted
  // and rendered via dangerouslySetInnerHTML, so it must not be served raw.
  const fullContentValues = {
    fullContentOriginal: result.contentOriginal ?? null,
    fullContentCleaned: result.contentCleaned ?? null,
    fullContentHash,
    fullContentFetchedAt: now,
    fullContentError: null,
    updatedAt: now,
  };
  // When fetchFullContent offloaded cleaning, the worker already sanitized the
  // cleaned HTML (fused into the same task); reuse it so we don't sanitize the
  // same body twice. The hint is only honored when its raw column is present in
  // fullContentValues (it always is here), so it can never desync from the raw.
  const fullContentUpdate = offloadSanitize
    ? await withSanitizedEntryContentAsync(fullContentValues, {
        fullContentCleanedSanitized: result.contentCleanedSanitized,
      })
    : withSanitizedEntryContent(fullContentValues);

  await db.update(entries).set(fullContentUpdate).where(eq(entries.id, entryId));
  return fullContentUpdate;
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

  const entry = await toFullEntry(db, rawEntry);

  logger.info("Fetching full content for entry", {
    entryId: entry.id,
    url: rawEntry.url,
  });

  const result = await fetchFullContent(rawEntry.url);
  const now = new Date();
  // Persist onto the shared entry row (see note above); the update carries
  // the sanitized columns so they can be served back to the client below.
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

  return {
    success: true,
    entry: {
      ...entry,
      fullContentOriginal: fullContentUpdate.fullContentOriginalSanitized ?? null,
      fullContentCleaned: fullContentUpdate.fullContentCleanedSanitized ?? null,
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
    if (error.name === "AbortError") {
      return "Request timed out";
    }
    return error.message;
  }

  return "Unknown error";
}

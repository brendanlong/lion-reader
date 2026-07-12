/**
 * Pure content processing utilities for feed entries.
 *
 * This module contains pure functions for processing entry content that don't
 * require database access. Extracted to allow unit testing without database imports.
 */

import type { ParsedEntry } from "./types";
import { absolutizeUrls } from "./content-cleaner";
import { getFeedPlugin } from "@/server/plugins";
import { generateSummary } from "../html/strip-html";
import { logger } from "@/lib/logger";

/**
 * Content processing result for an entry.
 */
export interface EntryContentResult {
  /** The original content with absolutized URLs */
  contentOriginal: string | null;
  /** Cleaned content (feed-specific cleaning applied), null if no cleaning needed */
  contentCleaned: string | null;
  /** The summary generated from original content */
  summary: string;
}

/**
 * Options for cleaning entry content.
 */
export interface CleanEntryContentOptions {
  /** The URL of the entry (used as base URL for absolutizing) */
  entryUrl?: string;
  /** The URL of the feed (used to detect feed-specific cleaners) */
  feedUrl?: string;
}

/**
 * Processes entry content: absolutizes URLs, applies feed-specific cleaning, and generates a summary.
 *
 * Note: We don't run Readability on feed entries because RSS/Atom/JSON feeds
 * already provide clean content. Readability is only used for saved articles
 * where we're extracting content from full web pages.
 *
 * Feed-specific cleaning is delegated to the matching plugin's `feed.cleanEntryContent`
 * capability (e.g. LessWrong strips its "Published on [date]<br/><br/>" prefix).
 *
 * @param parsedEntry - The parsed entry from the feed
 * @param options - Cleaning options
 * @returns Content result with original content, cleaned content (if applicable), and summary
 */
export function cleanEntryContent(
  parsedEntry: ParsedEntry,
  options: CleanEntryContentOptions = {}
): EntryContentResult {
  const { entryUrl, feedUrl } = options;
  const feedCapability = getFeedPlugin(feedUrl)?.capabilities.feed;
  const originalContent = parsedEntry.content ?? parsedEntry.summary ?? null;

  // Absolutize relative URLs in original content if we have a base URL
  const absolutizedOriginal =
    originalContent && entryUrl ? absolutizeUrls(originalContent, entryUrl) : originalContent;

  let contentCleaned: string | null = null;

  // Content synthesis via the matching plugin (if any): builds the entry body
  // from parsed-entry metadata for sources whose feeds carry no usable HTML
  // (e.g. YouTube's video embed + media:description). Takes precedence over
  // cleaning — the synthesized body replaces the feed content for display.
  const builder = feedCapability?.buildEntryContent;
  if (builder) {
    // Isolate plugin failures: a throwing hook must not fail the entry (or,
    // since this runs per-entry, every entry of the feed).
    try {
      contentCleaned = builder(parsedEntry, entryUrl);
    } catch (error) {
      logger.warn("Plugin buildEntryContent hook threw; using feed content", {
        feedUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // If no synthesized and no feed-provided content, return early
  if (!contentCleaned && !absolutizedOriginal) {
    return {
      contentOriginal: null,
      contentCleaned: null,
      summary: "",
    };
  }

  // Apply feed-specific content cleaning via the matching plugin (if any),
  // unless synthesis already produced the cleaned content.
  const cleaner = feedCapability?.cleanEntryContent;
  if (!contentCleaned && absolutizedOriginal && cleaner) {
    // Isolate plugin failures: fall back to the uncleaned-but-absolutized
    // content.
    try {
      const cleaned = cleaner(absolutizedOriginal);
      // Only set contentCleaned if cleaning actually changed something
      if (cleaned !== absolutizedOriginal) {
        contentCleaned = cleaned;
      }
    } catch (error) {
      logger.warn("Plugin cleanEntryContent hook threw; using uncleaned content", {
        feedUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Generate summary from content.
  // Only use feed-provided summary when the feed provides BOTH content and summary
  // AND they are different, meaning the summary is actually intended as an excerpt.
  // When content === summary (like RSS feeds without content:encoded), the parser
  // sets both to the same value, so we should use cleaned content for summary.
  // Non-null: the early return above fires when both are null.
  const contentForSummary = contentCleaned ?? absolutizedOriginal ?? "";
  const { content: entryContent, summary: entrySummary } = parsedEntry;
  const hasSeparateSummary = entryContent && entrySummary && entryContent !== entrySummary;
  const summary = hasSeparateSummary
    ? generateSummary(entrySummary)
    : generateSummary(contentForSummary);

  return {
    contentOriginal: absolutizedOriginal,
    contentCleaned,
    summary,
  };
}

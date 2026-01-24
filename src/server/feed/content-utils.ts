/**
 * Pure content processing utilities for feed entries.
 *
 * This module contains pure functions for processing entry content that don't
 * require database access. Extracted to allow unit testing without database imports.
 */

import type { ParsedEntry } from "./types";
import { absolutizeUrls, isLessWrongFeed, cleanLessWrongContent } from "./content-cleaner";
import { generateSummary } from "../html/strip-html";

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
 * Feed-specific cleaners:
 * - LessWrong/LesserWrong: Strips "Published on [date]<br/><br/>" prefix
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
  const originalContent = parsedEntry.content ?? parsedEntry.summary ?? null;

  // If no content, return early
  if (!originalContent) {
    return {
      contentOriginal: null,
      contentCleaned: null,
      summary: "",
    };
  }

  // Absolutize relative URLs in original content if we have a base URL
  const absolutizedOriginal = entryUrl
    ? absolutizeUrls(originalContent, entryUrl)
    : originalContent;

  // Apply feed-specific content cleaning
  let contentCleaned: string | null = null;

  if (isLessWrongFeed(feedUrl)) {
    const cleaned = cleanLessWrongContent(absolutizedOriginal);
    // Only set contentCleaned if cleaning actually changed something
    if (cleaned !== absolutizedOriginal) {
      contentCleaned = cleaned;
    }
  }

  // Generate summary from content.
  // Only use feed-provided summary when the feed provides BOTH content and summary
  // AND they are different, meaning the summary is actually intended as an excerpt.
  // When content === summary (like RSS feeds without content:encoded), the parser
  // sets both to the same value, so we should use cleaned content for summary.
  const contentForSummary = contentCleaned ?? absolutizedOriginal;
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

/**
 * Pure content processing utilities for feed entries.
 *
 * This module contains pure functions for processing entry content that don't
 * require database access. Extracted to allow unit testing without database imports.
 */

import type { ParsedEntry } from "./types";
import { absolutizeUrls } from "./content-cleaner";
import { getFeedHooks } from "@/server/plugins";
import { generateSummary, stripHtml } from "../html/strip-html";

/**
 * WordPress ends its auto-generated excerpts with "[…]" (or "[...]"), followed
 * by Yoast's "The post X appeared first on Y." when that plugin is installed.
 */
const WORDPRESS_AUTO_EXCERPT = /\[(?:…|\.\.\.)\](?:\s*The post .+ appeared first on .+\.)?$/;

/**
 * Summarizes a feed's separate summary, or returns "" when summarizing the
 * content ourselves is better: it has no text of its own (some WordPress feeds
 * put only the featured image or the "appeared first on" footer there), or it's
 * WordPress's auto-excerpt, a tag-stripped copy of the content's opening that
 * keeps footnote markers and loses super/subscripts.
 */
function summarizeWrittenSummary(html: string): string {
  if (WORDPRESS_AUTO_EXCERPT.test(stripHtml(html))) return "";
  return generateSummary(html, { imageAlt: false });
}

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
  const feedHooks = getFeedHooks(feedUrl);
  const originalContent = parsedEntry.content ?? parsedEntry.summary ?? null;

  // Absolutize relative URLs in original content if we have a base URL
  const absolutizedOriginal =
    originalContent && entryUrl ? absolutizeUrls(originalContent, entryUrl) : originalContent;

  // Content synthesis via the matching plugin (if any): builds the entry body
  // from parsed-entry metadata for sources whose feeds carry no usable HTML
  // (e.g. YouTube's video embed + media:description). Takes precedence over
  // cleaning — the synthesized body replaces the feed content for display.
  let contentCleaned = feedHooks.buildEntryContent(parsedEntry, entryUrl);

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
  if (!contentCleaned && absolutizedOriginal) {
    const cleaned = feedHooks.cleanEntryContent(absolutizedOriginal);
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
  // Non-null: the early return above fires when both are null.
  const contentForSummary = contentCleaned ?? absolutizedOriginal ?? "";
  const { content: entryContent, summary: entrySummary } = parsedEntry;
  const hasSeparateSummary = entryContent && entrySummary && entryContent !== entrySummary;
  const summary =
    (hasSeparateSummary && summarizeWrittenSummary(entrySummary)) ||
    generateSummary(contentForSummary) ||
    (hasSeparateSummary ? generateSummary(entrySummary) : "");

  return {
    contentOriginal: absolutizedOriginal,
    contentCleaned,
    summary,
  };
}

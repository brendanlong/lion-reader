/**
 * Streaming Atom 1.0 feed parser using SAX-style parsing.
 * Parses Atom feeds from a ReadableStream without loading the entire content into memory.
 */

import { Parser } from "htmlparser2";
import { decode } from "html-entities";
import type { ParsedFeed, ParsedEntry, SyndicationHints } from "../types";

/**
 * State machine states for Atom parsing.
 */
type AtomParserState =
  | "initial"
  | "in_feed"
  | "in_entry"
  | "in_feed_title"
  | "in_feed_subtitle"
  | "in_feed_icon"
  | "in_feed_logo"
  | "in_feed_sy_updatePeriod"
  | "in_feed_sy_updateFrequency"
  | "in_entry_id"
  | "in_entry_title"
  | "in_entry_summary"
  | "in_entry_content"
  | "in_entry_published"
  | "in_entry_updated"
  | "in_entry_author"
  | "in_entry_author_name";

/**
 * Valid update period values from the Syndication namespace.
 */
const VALID_UPDATE_PERIODS = ["hourly", "daily", "weekly", "monthly", "yearly"] as const;
type UpdatePeriod = (typeof VALID_UPDATE_PERIODS)[number];

/**
 * Parses an Atom feed from a ReadableStream.
 *
 * @param stream - The readable stream containing Atom XML data
 * @returns A promise that resolves to a ParsedFeed
 */
export async function parseAtomStream(stream: ReadableStream<Uint8Array>): Promise<ParsedFeed> {
  // Feed metadata
  let title: string | undefined;
  let description: string | undefined;
  let siteUrl: string | undefined;
  let iconUrl: string | undefined;
  let hubUrl: string | undefined;
  let selfUrl: string | undefined;
  let syndication: SyndicationHints | undefined;
  let syUpdatePeriod: string | undefined;
  let syUpdateFrequency: number | undefined;

  // Current entry being parsed
  let currentEntry: Partial<ParsedEntry> | null = null;
  let currentEntryContent: string | undefined;

  // All parsed entries
  const items: ParsedEntry[] = [];

  // Parser state
  let state: AtomParserState = "initial";
  let textBuffer = "";
  const elementStack: string[] = [];
  let inFeedLevel = false;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tagName = name.toLowerCase();
        elementStack.push(tagName);

        // Feed element
        if (tagName === "feed") {
          state = "in_feed";
          inFeedLevel = true;
        }

        // Entry element
        if (tagName === "entry") {
          state = "in_entry";
          currentEntry = {};
          currentEntryContent = undefined;
          inFeedLevel = false;
        }

        // Feed-level elements (only when not in an entry)
        if (inFeedLevel && state === "in_feed") {
          if (tagName === "title") state = "in_feed_title";
          else if (tagName === "subtitle") state = "in_feed_subtitle";
          else if (tagName === "icon") state = "in_feed_icon";
          else if (tagName === "logo") state = "in_feed_logo";
          else if (tagName === "sy:updateperiod") state = "in_feed_sy_updatePeriod";
          else if (tagName === "sy:updatefrequency") state = "in_feed_sy_updateFrequency";

          // Handle link elements
          if (tagName === "link") {
            const rel = attribs.rel;
            const href = attribs.href;
            if (href) {
              if (rel === "alternate" || !rel) {
                siteUrl = href;
              } else if (rel === "hub") {
                hubUrl = href;
              } else if (rel === "self") {
                selfUrl = href;
              }
            }
          }
        }

        // Entry-level elements
        if (state === "in_entry" && currentEntry) {
          if (tagName === "id") state = "in_entry_id";
          else if (tagName === "title") state = "in_entry_title";
          else if (tagName === "summary") state = "in_entry_summary";
          else if (tagName === "content") {
            state = "in_entry_content";
          } else if (tagName === "published") state = "in_entry_published";
          else if (tagName === "updated") state = "in_entry_updated";
          else if (tagName === "author") state = "in_entry_author";

          // Handle link elements in entry
          if (tagName === "link") {
            const rel = attribs.rel;
            const href = attribs.href;
            if (href && (rel === "alternate" || !rel)) {
              currentEntry.link = href;
            }
          }
        }

        // Author name
        if (state === "in_entry_author" && tagName === "name") {
          state = "in_entry_author_name";
        }

        textBuffer = "";
      },

      ontext(text) {
        textBuffer += text;
      },

      onclosetag(name) {
        const tagName = name.toLowerCase();
        const trimmedText = textBuffer.trim();
        const decodedText = trimmedText ? decode(trimmedText) : undefined;

        // Feed-level elements
        if (state === "in_feed_title") {
          title = decodedText;
          state = "in_feed";
        } else if (state === "in_feed_subtitle") {
          description = decodedText;
          state = "in_feed";
        } else if (state === "in_feed_icon") {
          iconUrl = decodedText;
          state = "in_feed";
        } else if (state === "in_feed_logo") {
          // Use logo as icon fallback
          if (!iconUrl) {
            iconUrl = decodedText;
          }
          state = "in_feed";
        } else if (state === "in_feed_sy_updatePeriod") {
          if (decodedText) {
            const normalized = decodedText.toLowerCase() as UpdatePeriod;
            if (VALID_UPDATE_PERIODS.includes(normalized)) {
              syUpdatePeriod = normalized;
            }
          }
          state = "in_feed";
        } else if (state === "in_feed_sy_updateFrequency") {
          if (decodedText) {
            const parsed = parseInt(decodedText, 10);
            if (!isNaN(parsed) && parsed > 0) {
              syUpdateFrequency = parsed;
            }
          }
          state = "in_feed";
        }

        // Entry-level elements
        if (currentEntry) {
          if (state === "in_entry_id") {
            currentEntry.guid = decodedText;
            state = "in_entry";
          } else if (state === "in_entry_title") {
            currentEntry.title = decodedText;
            state = "in_entry";
          } else if (state === "in_entry_summary") {
            currentEntry.summary = decodedText;
            // Use as content if no content element
            if (!currentEntryContent) {
              currentEntry.content = decodedText;
            }
            state = "in_entry";
          } else if (state === "in_entry_content") {
            currentEntryContent = decodedText;
            currentEntry.content = decodedText;
            state = "in_entry";
          } else if (state === "in_entry_published") {
            if (decodedText) {
              const date = parseAtomDate(decodedText);
              if (date) {
                currentEntry.pubDate = date;
              }
            }
            state = "in_entry";
          } else if (state === "in_entry_updated") {
            // Only use updated if published not set
            if (!currentEntry.pubDate && decodedText) {
              const date = parseAtomDate(decodedText);
              if (date) {
                currentEntry.pubDate = date;
              }
            }
            state = "in_entry";
          } else if (state === "in_entry_author_name") {
            currentEntry.author = decodedText;
            state = "in_entry_author";
          } else if (state === "in_entry_author" && tagName === "author") {
            state = "in_entry";
          }
        }

        // End of entry
        if (tagName === "entry" && currentEntry) {
          items.push(currentEntry as ParsedEntry);
          currentEntry = null;
          state = "in_feed";
          inFeedLevel = true;
        }

        // End of feed
        if (tagName === "feed") {
          state = "initial";
          inFeedLevel = false;
        }

        elementStack.pop();
        textBuffer = "";
      },
    },
    {
      xmlMode: true,
      decodeEntities: false, // We decode manually with html-entities
      lowerCaseTags: true,
      lowerCaseAttributeNames: true,
    }
  );

  // Process the stream
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      parser.write(chunk);
    }

    // Flush any remaining data
    parser.end();
  } finally {
    reader.releaseLock();
  }

  // Build syndication hints if present
  if (syUpdatePeriod !== undefined || syUpdateFrequency !== undefined) {
    syndication = {};
    if (syUpdatePeriod) {
      syndication.updatePeriod = syUpdatePeriod as UpdatePeriod;
    }
    if (syUpdateFrequency) {
      syndication.updateFrequency = syUpdateFrequency;
    }
  }

  return {
    title,
    description,
    siteUrl,
    iconUrl,
    items,
    hubUrl,
    selfUrl,
    syndication,
  };
}

/**
 * Parses various date formats commonly found in Atom feeds.
 * Atom uses RFC 3339 (a profile of ISO 8601).
 * Returns undefined if the date cannot be parsed.
 */
function parseAtomDate(dateString: string): Date | undefined {
  const trimmed = dateString.trim();
  if (!trimmed) {
    return undefined;
  }

  // Try native Date parsing (handles ISO 8601 / RFC 3339)
  const nativeDate = new Date(trimmed);
  if (!isNaN(nativeDate.getTime())) {
    return nativeDate;
  }

  return undefined;
}

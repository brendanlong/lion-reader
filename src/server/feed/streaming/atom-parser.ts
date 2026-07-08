/**
 * Atom 1.0 feed parser using SAX-style parsing.
 * Parses Atom feeds from a string, returning entries synchronously.
 */

import { Parser } from "htmlparser2";
import type { ParsedEntry, SyndicationHints } from "../types";
import type { FeedParseResult } from "./types";
import { VALID_UPDATE_PERIODS, type UpdatePeriod } from "./syndication";

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
 * Parses an Atom feed from a string.
 *
 * @param content - The Atom XML content as a string
 * @returns Parsed feed metadata and entries
 */
export function parseAtom(content: string): FeedParseResult {
  let title: string | undefined;
  let description: string | undefined;
  let siteUrl: string | undefined;
  let iconUrl: string | undefined;
  let hubUrl: string | undefined;
  let selfUrl: string | undefined;
  let syndication: SyndicationHints | undefined;
  let syUpdatePeriod: string | undefined;
  let syUpdateFrequency: number | undefined;

  let currentEntry: Partial<ParsedEntry> | null = null;
  let currentEntryContent: string | undefined;

  let state: AtomParserState = "initial";
  let textBuffer = "";
  let inFeedLevel = false;
  // Depth of nested <source> elements inside the current entry. Atom copies an
  // entry with a <source> describing its *original* feed (Planet-style
  // aggregators do this), whose <id>/<title>/<published>/<link> would otherwise
  // overwrite the entry's own fields. While inside a <source> we ignore element
  // mapping so those children don't clobber the entry.
  let sourceDepth = 0;

  const entries: ParsedEntry[] = [];
  let parseError: Error | null = null;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tagName = name.toLowerCase();

        if (tagName === "feed") {
          state = "in_feed";
          inFeedLevel = true;
        }

        if (tagName === "entry") {
          state = "in_entry";
          currentEntry = {};
          currentEntryContent = undefined;
          inFeedLevel = false;
          sourceDepth = 0;
        }

        // Track <source> nesting so the copied source feed's metadata doesn't
        // overwrite the entry's own fields.
        if (tagName === "source") {
          sourceDepth++;
        }

        if (inFeedLevel && state === "in_feed") {
          if (tagName === "title") state = "in_feed_title";
          else if (tagName === "subtitle") state = "in_feed_subtitle";
          else if (tagName === "icon") state = "in_feed_icon";
          else if (tagName === "logo") state = "in_feed_logo";
          else if (tagName === "sy:updateperiod") state = "in_feed_sy_updatePeriod";
          else if (tagName === "sy:updatefrequency") state = "in_feed_sy_updateFrequency";

          if (tagName === "link") {
            const rel = attribs.rel;
            const href = attribs.href;
            if (href) {
              if (rel === "alternate" || !rel) siteUrl = href;
              else if (rel === "hub") hubUrl = href;
              else if (rel === "self") selfUrl = href;
            }
          }
        }

        // Skip element mapping while inside a copied <source> (sourceDepth > 0):
        // the entry's <source> reopens as `tagName === "source"`, so sourceDepth
        // is already ≥ 1 here and its children (id/title/published/link/...) are
        // ignored rather than overwriting the entry's own fields.
        if (state === "in_entry" && currentEntry && sourceDepth === 0) {
          if (tagName === "id") state = "in_entry_id";
          else if (tagName === "title") state = "in_entry_title";
          else if (tagName === "summary") state = "in_entry_summary";
          else if (tagName === "content") state = "in_entry_content";
          else if (tagName === "published") state = "in_entry_published";
          else if (tagName === "updated") state = "in_entry_updated";
          else if (tagName === "author") state = "in_entry_author";

          if (tagName === "link") {
            const rel = attribs.rel;
            const href = attribs.href;
            if (href && (rel === "alternate" || !rel)) {
              currentEntry.link = href;
            }
          }
        }

        if (state === "in_entry_author" && tagName === "name" && sourceDepth === 0) {
          state = "in_entry_author_name";
        }

        textBuffer = "";
      },

      ontext(text) {
        textBuffer += text;
      },

      onclosetag(name) {
        const tagName = name.toLowerCase();

        if (tagName === "source" && sourceDepth > 0) {
          sourceDepth--;
        }

        const trimmedText = textBuffer.trim();
        // Entities are decoded natively by htmlparser2 (decodeEntities: true),
        // while CDATA stays literal. Decoding again would corrupt escaped HTML
        // in content bodies (e.g. `&lt;tag&gt;` code samples turning into tags).
        const decodedText = trimmedText || undefined;

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
          if (!iconUrl) iconUrl = decodedText;
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

        if (currentEntry) {
          if (state === "in_entry_id") {
            currentEntry.guid = decodedText;
            state = "in_entry";
          } else if (state === "in_entry_title") {
            currentEntry.title = decodedText;
            state = "in_entry";
          } else if (state === "in_entry_summary") {
            currentEntry.summary = decodedText;
            if (!currentEntryContent) currentEntry.content = decodedText;
            state = "in_entry";
          } else if (state === "in_entry_content") {
            currentEntryContent = decodedText;
            currentEntry.content = decodedText;
            state = "in_entry";
          } else if (state === "in_entry_published") {
            if (decodedText) {
              const date = new Date(decodedText);
              if (!isNaN(date.getTime())) currentEntry.pubDate = date;
            }
            state = "in_entry";
          } else if (state === "in_entry_updated") {
            if (!currentEntry.pubDate && decodedText) {
              const date = new Date(decodedText);
              if (!isNaN(date.getTime())) currentEntry.pubDate = date;
            }
            state = "in_entry";
          } else if (state === "in_entry_author_name") {
            currentEntry.author = decodedText;
            state = "in_entry_author";
          } else if (state === "in_entry_author" && tagName === "author") {
            state = "in_entry";
          }
        }

        if (tagName === "entry" && currentEntry) {
          entries.push(currentEntry as ParsedEntry);
          currentEntry = null;
          state = "in_feed";
          inFeedLevel = true;
        }

        if (tagName === "feed") {
          state = "initial";
          inFeedLevel = false;
        }

        textBuffer = "";
      },

      onerror(error) {
        parseError = error;
      },
    },
    {
      xmlMode: true,
      // Decode entities natively; CDATA stays literal. This avoids the
      // double-decode that corrupted escaped HTML in content bodies.
      decodeEntities: true,
      lowerCaseTags: true,
      lowerCaseAttributeNames: true,
    }
  );

  // Parse the content
  parser.write(content);
  parser.end();

  if (parseError) {
    throw parseError;
  }

  // Build syndication object if present
  if (syUpdatePeriod !== undefined || syUpdateFrequency !== undefined) {
    syndication = {};
    if (syUpdatePeriod) syndication.updatePeriod = syUpdatePeriod as UpdatePeriod;
    if (syUpdateFrequency) syndication.updateFrequency = syUpdateFrequency;
  }

  return {
    title,
    description,
    siteUrl,
    iconUrl,
    hubUrl,
    selfUrl,
    syndication,
    entries,
  };
}

/**
 * Streaming Atom 1.0 feed parser using SAX-style parsing.
 * Parses Atom feeds from a ReadableStream, yielding entries as they're parsed.
 */

import { Parser } from "htmlparser2";
import { decode } from "html-entities";
import type { ParsedEntry, SyndicationHints } from "../types";
import type { StreamingFeedResult } from "./types";

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

const VALID_UPDATE_PERIODS = ["hourly", "daily", "weekly", "monthly", "yearly"] as const;
type UpdatePeriod = (typeof VALID_UPDATE_PERIODS)[number];

/**
 * Parses an Atom feed from a ReadableStream.
 * Returns immediately with metadata once available; entries are yielded via async generator.
 */
export async function parseAtomStream(
  stream: ReadableStream<Uint8Array>
): Promise<StreamingFeedResult> {
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

  const entryQueue: ParsedEntry[] = [];
  let entryResolve: () => void = () => {};
  let parsingComplete = false;
  let parseError: Error | null = null;

  let metadataReady = false;
  let resolveMetadata!: () => void;
  const metadataPromise = new Promise<void>((resolve) => {
    resolveMetadata = resolve;
  });

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tagName = name.toLowerCase();

        if (tagName === "feed") {
          state = "in_feed";
          inFeedLevel = true;
        }

        if (tagName === "entry") {
          if (!metadataReady) {
            metadataReady = true;
            buildSyndication();
            resolveMetadata();
          }
          state = "in_entry";
          currentEntry = {};
          currentEntryContent = undefined;
          inFeedLevel = false;
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

        if (state === "in_entry" && currentEntry) {
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
          entryQueue.push(currentEntry as ParsedEntry);
          entryResolve();
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
        entryResolve();
        resolveMetadata();
      },
    },
    {
      xmlMode: true,
      decodeEntities: false,
      lowerCaseTags: true,
      lowerCaseAttributeNames: true,
    }
  );

  function buildSyndication() {
    if (syUpdatePeriod !== undefined || syUpdateFrequency !== undefined) {
      syndication = {};
      if (syUpdatePeriod) syndication.updatePeriod = syUpdatePeriod as UpdatePeriod;
      if (syUpdateFrequency) syndication.updateFrequency = syUpdateFrequency;
    }
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        parser.write(chunk);
      }
      parser.end();

      if (!metadataReady) {
        metadataReady = true;
        buildSyndication();
        resolveMetadata();
      }
    } catch (error) {
      parseError = error instanceof Error ? error : new Error(String(error));
    } finally {
      parsingComplete = true;
      entryResolve();
      reader.releaseLock();
    }
  })();

  await metadataPromise;

  if (parseError) throw parseError;

  async function* entriesGenerator(): AsyncGenerator<ParsedEntry, void, undefined> {
    while (true) {
      if (entryQueue.length > 0) {
        yield entryQueue.shift()!;
      } else if (parsingComplete) {
        if (parseError) throw parseError;
        return;
      } else {
        await new Promise<void>((resolve) => {
          entryResolve = resolve;
        });
      }
    }
  }

  return {
    title,
    description,
    siteUrl,
    iconUrl,
    hubUrl,
    selfUrl,
    syndication,
    entries: entriesGenerator(),
  };
}

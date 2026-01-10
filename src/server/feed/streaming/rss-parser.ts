/**
 * Streaming RSS 2.0 feed parser using SAX-style parsing.
 * Parses RSS feeds from a ReadableStream, yielding entries as they're parsed.
 */

import { Parser } from "htmlparser2";
import { decode } from "html-entities";
import type { ParsedEntry, SyndicationHints } from "../types";
import type { StreamingFeedResult } from "./types";

/**
 * State machine states for RSS parsing.
 */
type RssParserState =
  | "initial"
  | "in_channel"
  | "in_item"
  | "in_channel_title"
  | "in_channel_link"
  | "in_channel_description"
  | "in_channel_ttl"
  | "in_channel_sy_updatePeriod"
  | "in_channel_sy_updateFrequency"
  | "in_image"
  | "in_image_url"
  | "in_item_title"
  | "in_item_link"
  | "in_item_description"
  | "in_item_content_encoded"
  | "in_item_guid"
  | "in_item_author"
  | "in_item_dc_creator"
  | "in_item_pubDate"
  | "in_item_dc_date";

const VALID_UPDATE_PERIODS = ["hourly", "daily", "weekly", "monthly", "yearly"] as const;
type UpdatePeriod = (typeof VALID_UPDATE_PERIODS)[number];

/**
 * Parses an RSS feed from a ReadableStream.
 * Returns immediately with metadata once available; entries are yielded via async generator.
 *
 * @param stream - The readable stream containing RSS XML data
 * @returns A promise that resolves to metadata + async generator of entries
 */
export async function parseRssStream(
  stream: ReadableStream<Uint8Array>
): Promise<StreamingFeedResult> {
  // Feed metadata
  let title: string | undefined;
  let description: string | undefined;
  let siteUrl: string | undefined;
  let iconUrl: string | undefined;
  let hubUrl: string | undefined;
  let selfUrl: string | undefined;
  let ttlMinutes: number | undefined;
  let syndication: SyndicationHints | undefined;
  let syUpdatePeriod: string | undefined;
  let syUpdateFrequency: number | undefined;

  // Current item being parsed
  let currentItem: Partial<ParsedEntry> | null = null;
  let currentItemContentEncoded: string | undefined;

  // Parser state
  let state: RssParserState = "initial";
  let textBuffer = "";
  let isRdf = false;

  // Entry queue for async generator
  const entryQueue: ParsedEntry[] = [];
  let entryResolve: () => void = () => {};
  let parsingComplete = false;
  let parseError: Error | null = null;

  // Metadata ready promise
  let metadataReady = false;
  let resolveMetadata!: () => void;
  const metadataPromise = new Promise<void>((resolve) => {
    resolveMetadata = resolve;
  });

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tagName = name.toLowerCase();

        if (tagName === "rdf:rdf") {
          isRdf = true;
          state = "in_channel";
        }

        if (tagName === "channel") {
          state = "in_channel";
        }

        if (tagName === "item") {
          // Metadata is ready when we see the first item
          if (!metadataReady) {
            metadataReady = true;
            buildSyndication();
            resolveMetadata();
          }
          state = "in_item";
          currentItem = {};
          currentItemContentEncoded = undefined;
        }

        // Channel-level elements
        if (state === "in_channel" || (isRdf && state === "initial")) {
          if (tagName === "title") state = "in_channel_title";
          else if (tagName === "link" && !attribs.rel) state = "in_channel_link";
          else if (tagName === "description") state = "in_channel_description";
          else if (tagName === "ttl") state = "in_channel_ttl";
          else if (tagName === "sy:updateperiod") state = "in_channel_sy_updatePeriod";
          else if (tagName === "sy:updatefrequency") state = "in_channel_sy_updateFrequency";
          else if (tagName === "image") state = "in_image";

          if (tagName === "atom:link") {
            const rel = attribs.rel;
            const href = attribs.href;
            if (rel === "hub" && href) hubUrl = href;
            if (rel === "self" && href) selfUrl = href;
          }
        }

        if (state === "in_image" && tagName === "url") {
          state = "in_image_url";
        }

        if (state === "in_item" && currentItem) {
          if (tagName === "title") state = "in_item_title";
          else if (tagName === "link") state = "in_item_link";
          else if (tagName === "description") state = "in_item_description";
          else if (tagName === "content:encoded") state = "in_item_content_encoded";
          else if (tagName === "guid") state = "in_item_guid";
          else if (tagName === "author") state = "in_item_author";
          else if (tagName === "dc:creator") state = "in_item_dc_creator";
          else if (tagName === "pubdate") state = "in_item_pubDate";
          else if (tagName === "dc:date") state = "in_item_dc_date";
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

        // Channel-level elements
        if (state === "in_channel_title") {
          title = decodedText;
          state = "in_channel";
        } else if (state === "in_channel_link") {
          siteUrl = decodedText;
          state = "in_channel";
        } else if (state === "in_channel_description") {
          description = decodedText;
          state = "in_channel";
        } else if (state === "in_channel_ttl") {
          if (decodedText) {
            const parsed = parseInt(decodedText, 10);
            if (!isNaN(parsed) && parsed > 0) {
              ttlMinutes = parsed;
            }
          }
          state = "in_channel";
        } else if (state === "in_channel_sy_updatePeriod") {
          if (decodedText) {
            const normalized = decodedText.toLowerCase() as UpdatePeriod;
            if (VALID_UPDATE_PERIODS.includes(normalized)) {
              syUpdatePeriod = normalized;
            }
          }
          state = "in_channel";
        } else if (state === "in_channel_sy_updateFrequency") {
          if (decodedText) {
            const parsed = parseInt(decodedText, 10);
            if (!isNaN(parsed) && parsed > 0) {
              syUpdateFrequency = parsed;
            }
          }
          state = "in_channel";
        } else if (state === "in_image_url") {
          iconUrl = decodedText;
          state = "in_image";
        } else if (state === "in_image" && tagName === "image") {
          state = "in_channel";
        }

        // Item-level elements
        if (currentItem) {
          if (state === "in_item_title") {
            currentItem.title = decodedText;
            state = "in_item";
          } else if (state === "in_item_link") {
            currentItem.link = decodedText;
            state = "in_item";
          } else if (state === "in_item_description") {
            currentItem.summary = decodedText;
            if (!currentItemContentEncoded) {
              currentItem.content = decodedText;
            }
            state = "in_item";
          } else if (state === "in_item_content_encoded") {
            currentItemContentEncoded = decodedText;
            currentItem.content = decodedText;
            state = "in_item";
          } else if (state === "in_item_guid") {
            currentItem.guid = decodedText;
            state = "in_item";
          } else if (state === "in_item_author") {
            if (!currentItem.author) {
              currentItem.author = decodedText;
            }
            state = "in_item";
          } else if (state === "in_item_dc_creator") {
            currentItem.author = decodedText;
            state = "in_item";
          } else if (state === "in_item_pubDate") {
            if (decodedText) {
              const date = parseRssDate(decodedText);
              if (date) {
                currentItem.pubDate = date;
              }
            }
            state = "in_item";
          } else if (state === "in_item_dc_date") {
            if (!currentItem.pubDate && decodedText) {
              const date = parseRssDate(decodedText);
              if (date) {
                currentItem.pubDate = date;
              }
            }
            state = "in_item";
          }
        }

        // End of item - push to queue
        if (tagName === "item" && currentItem) {
          entryQueue.push(currentItem as ParsedEntry);
          entryResolve();
          currentItem = null;
          state = isRdf ? "initial" : "in_channel";
        }

        if (tagName === "channel") {
          state = isRdf ? "initial" : "initial";
        }

        textBuffer = "";
      },

      onerror(error) {
        parseError = error;
        entryResolve();
        if (!metadataReady) {
          metadataReady = true;
          resolveMetadata();
        }
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
      if (syUpdatePeriod) {
        syndication.updatePeriod = syUpdatePeriod as UpdatePeriod;
      }
      if (syUpdateFrequency) {
        syndication.updateFrequency = syUpdateFrequency;
      }
    }
  }

  // Start reading the stream in the background
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

      // If no items were found, metadata is ready now
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

  // Wait for metadata to be ready
  await metadataPromise;

  if (parseError) {
    throw parseError;
  }

  // Create async generator for entries
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
    ttlMinutes,
    syndication,
    entries: entriesGenerator(),
  };
}

function parseRssDate(dateString: string): Date | undefined {
  const trimmed = dateString.trim();
  if (!trimmed) return undefined;

  const nativeDate = new Date(trimmed);
  if (!isNaN(nativeDate.getTime())) return nativeDate;

  const ddMonYyyy = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/;
  const match = trimmed.match(ddMonYyyy);
  if (match) {
    const parsed = new Date(
      `${match[2]} ${match[1]}, ${match[3]} ${match[4]}:${match[5]}:${match[6]} GMT`
    );
    if (!isNaN(parsed.getTime())) return parsed;
  }

  const timezoneMap: Record<string, string> = {
    PST: "-0800",
    PDT: "-0700",
    MST: "-0700",
    MDT: "-0600",
    CST: "-0600",
    CDT: "-0500",
    EST: "-0500",
    EDT: "-0400",
    GMT: "+0000",
    UTC: "+0000",
  };

  for (const [abbr, offset] of Object.entries(timezoneMap)) {
    if (trimmed.includes(abbr)) {
      const normalized = trimmed.replace(abbr, offset);
      const parsed = new Date(normalized);
      if (!isNaN(parsed.getTime())) return parsed;
    }
  }

  return undefined;
}

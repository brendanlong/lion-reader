/**
 * OPML (Outline Processor Markup Language) parser and generator.
 * Handles importing and exporting feed subscriptions in the standard OPML format.
 *
 * OPML is an XML format commonly used for exchanging lists of RSS/Atom feeds
 * between feed readers. It supports nested folders/categories through nested
 * outline elements.
 *
 * Parsing is the native `@lion-reader/feed-parser` module's SAX state machine
 * (`native/feed-parser/core/src/opml.rs`); structural validation and the error
 * type live here.
 *
 * @see http://opml.org/spec2.opml
 */

import { XMLBuilder } from "fast-xml-parser";
import {
  parseOpml as nativeParseOpml,
  parseOpmlAsync as nativeParseOpmlAsync,
} from "@lion-reader/feed-parser";
import type { RawOpmlResult } from "@lion-reader/feed-parser";
import { NATIVE_INLINE_MAX_CHARS } from "@/server/native-inline";

/**
 * A feed parsed from OPML.
 */
export interface OpmlFeed {
  /** Feed title (from text or title attribute) */
  title?: string;
  /** URL to the feed XML */
  xmlUrl: string;
  /** URL to the feed's website */
  htmlUrl?: string;
  /** Category path as array (e.g., ["Tech", "Programming"]) */
  category?: string[];
}

/**
 * Error thrown when OPML parsing fails.
 */
export class OpmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpmlParseError";
  }
}

/**
 * Input subscription for OPML generation.
 */
export interface OpmlSubscription {
  /** Feed title */
  title: string;
  /** URL to the feed XML */
  xmlUrl: string;
  /** URL to the feed's website */
  htmlUrl?: string;
  /** Tags/folders the feed belongs to (optional, multiple tags) */
  tags?: string[];
}

/**
 * OPML document metadata for generation.
 */
export interface OpmlMetadata {
  /** Document title */
  title?: string;
  /** Owner name */
  ownerName?: string;
  /** Owner email */
  ownerEmail?: string;
}

function toOpmlFeeds(raw: RawOpmlResult): OpmlFeed[] {
  if (!raw.hasOpml) {
    throw new OpmlParseError("Invalid OPML: missing opml element");
  }
  if (!raw.hasBody) {
    throw new OpmlParseError("Invalid OPML: missing body element");
  }
  return raw.feeds.map((feed) => ({
    xmlUrl: feed.xmlUrl,
    title: feed.title,
    htmlUrl: feed.htmlUrl,
    category: feed.category,
  }));
}

/** Wrap XML-level parse failures so callers always see an OpmlParseError. */
function toOpmlError(error: unknown): OpmlParseError {
  return error instanceof OpmlParseError
    ? error
    : new OpmlParseError(`Invalid OPML: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * Parses an OPML XML string into an array of feeds.
 *
 * The native parser runs on the libuv thread pool, so a large OPML upload
 * never blocks the event loop that serves UI requests (small inputs parse
 * inline).
 *
 * @param xml - The OPML XML content as a string
 * @returns Array of parsed feeds with their categories
 * @throws OpmlParseError if the XML is not valid OPML
 */
export async function parseOpmlAsync(xml: string): Promise<OpmlFeed[]> {
  try {
    return toOpmlFeeds(
      xml.length <= NATIVE_INLINE_MAX_CHARS ? nativeParseOpml(xml) : await nativeParseOpmlAsync(xml)
    );
  } catch (error) {
    throw toOpmlError(error);
  }
}

/**
 * Groups subscriptions by tags for multi-tag export.
 * Returns a map where keys are tag names and values are subscriptions with that tag.
 */
function groupByTags(subscriptions: OpmlSubscription[]): Map<string, OpmlSubscription[]> {
  const groups = new Map<string, OpmlSubscription[]>();

  for (const sub of subscriptions) {
    if (sub.tags && sub.tags.length > 0) {
      for (const tag of sub.tags) {
        const existing = groups.get(tag);
        if (existing) {
          existing.push(sub);
        } else {
          groups.set(tag, [sub]);
        }
      }
    }
  }

  return groups;
}

/**
 * Builds an outline object for a subscription (used by XMLBuilder).
 */
function buildOutlineObject(sub: OpmlSubscription): OutlineElement {
  const outline: OutlineElement = {
    "@_type": "rss",
    "@_text": sub.title,
    "@_title": sub.title,
    "@_xmlUrl": sub.xmlUrl,
  };

  if (sub.htmlUrl) {
    outline["@_htmlUrl"] = sub.htmlUrl;
  }

  return outline;
}

/**
 * Outline element type for XMLBuilder.
 */
interface OutlineElement {
  "@_type"?: string;
  "@_text": string;
  "@_title"?: string;
  "@_xmlUrl"?: string;
  "@_htmlUrl"?: string;
  outline?: OutlineElement[];
}

/**
 * OPML document structure for XMLBuilder.
 */
interface OpmlDocument {
  "?xml": { "@_version": string; "@_encoding": string };
  opml: {
    "@_version": string;
    head: {
      title: string;
      dateCreated: string;
      ownerName?: string;
      ownerEmail?: string;
    };
    body: {
      outline: OutlineElement[];
    };
  };
}

/**
 * Generates OPML XML from a list of subscriptions.
 *
 * The export format is:
 * - All feeds listed at top level (no folder)
 * - Feeds re-listed inside each tag folder they belong to
 *
 * @param subscriptions - Array of subscriptions to export
 * @param metadata - Optional document metadata
 * @returns OPML XML string
 *
 * @example
 * ```ts
 * const xml = generateOpml([
 *   { title: "Blog", xmlUrl: "https://blog.example.com/feed", tags: ["Tech", "Favorites"] },
 *   { title: "News", xmlUrl: "https://news.example.com/rss" }
 * ], { title: "My Subscriptions" });
 * ```
 */
export function generateOpml(
  subscriptions: OpmlSubscription[],
  metadata: OpmlMetadata = {}
): string {
  const dateCreated = new Date().toISOString();

  // Build outline elements: all feeds at top level + re-listed in tag folders
  const outlines: OutlineElement[] = [];

  // First, add ALL subscriptions at top level
  for (const sub of subscriptions) {
    outlines.push(buildOutlineObject(sub));
  }

  // Then, add tag folders with their subscriptions
  const tagGroups = groupByTags(subscriptions);
  // Sort tag folders alphabetically for consistent output
  const sortedTags = Array.from(tagGroups.keys()).sort();
  for (const tag of sortedTags) {
    const subs = tagGroups.get(tag)!;
    outlines.push({
      "@_text": tag,
      outline: subs.map((sub) => buildOutlineObject(sub)),
    });
  }

  const title = metadata.title || "Lion Reader Subscriptions";

  // Build the OPML document structure
  const doc: OpmlDocument = {
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    opml: {
      "@_version": "2.0",
      head: {
        title,
        dateCreated,
      },
      body: {
        outline: outlines,
      },
    },
  };

  // Add optional metadata
  if (metadata.ownerName) {
    doc.opml.head.ownerName = metadata.ownerName;
  }
  if (metadata.ownerEmail) {
    doc.opml.head.ownerEmail = metadata.ownerEmail;
  }

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    format: true,
    indentBy: "  ",
    suppressEmptyNode: true,
  });

  return builder.build(doc) as string;
}

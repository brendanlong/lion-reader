/**
 * OPML (Outline Processor Markup Language) parser and generator.
 * Handles importing and exporting feed subscriptions in the standard OPML format.
 *
 * OPML is an XML format commonly used for exchanging lists of RSS/Atom feeds
 * between feed readers. It supports nested folders/categories through nested
 * outline elements.
 *
 * Uses SAX-style parsing for memory efficiency.
 *
 * @see http://opml.org/spec2.opml
 */

import { XMLBuilder } from "fast-xml-parser";
import { parseOpml as parseOpmlInternal, OpmlParseError } from "./streaming/opml-parser";

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

// Re-export error for backwards compatibility
export { OpmlParseError };

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
  /** Category/folder name (optional, single folder) */
  folder?: string;
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

/**
 * Parses an OPML XML string into an array of feeds.
 *
 * @param xml - The OPML XML content as a string
 * @returns Array of parsed feeds with their categories
 * @throws OpmlParseError if the XML is not valid OPML
 *
 * @example
 * ```ts
 * const feeds = parseOpml(opmlXml);
 * // [
 * //   { title: "Blog Name", xmlUrl: "https://...", category: ["Tech"] },
 * //   { title: "News", xmlUrl: "https://...", category: ["News", "Daily"] }
 * // ]
 * ```
 */
export function parseOpml(xml: string): OpmlFeed[] {
  const result = parseOpmlInternal(xml);
  return result.feeds as OpmlFeed[];
}

/**
 * Groups subscriptions by folder (legacy single-folder support).
 */
function groupByFolder(
  subscriptions: OpmlSubscription[]
): Map<string | undefined, OpmlSubscription[]> {
  const groups = new Map<string | undefined, OpmlSubscription[]>();

  for (const sub of subscriptions) {
    const folder = sub.folder;
    const existing = groups.get(folder);
    if (existing) {
      existing.push(sub);
    } else {
      groups.set(folder, [sub]);
    }
  }

  return groups;
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
 * When subscriptions have `tags`, the export format is:
 * - All feeds listed at top level (no folder)
 * - Feeds re-listed inside each tag folder they belong to
 *
 * When subscriptions use `folder` (legacy), the format is:
 * - Feeds without folder at top level
 * - Feeds with folder inside their respective folder
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

  // Check if any subscriptions use the new tags format
  const hasTagsFormat = subscriptions.some((sub) => sub.tags !== undefined);

  // Build outline elements
  const outlines: OutlineElement[] = [];

  if (hasTagsFormat) {
    // New format: all feeds at top level + re-listed in tag folders
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
  } else {
    // Legacy format: group by single folder
    const grouped = groupByFolder(subscriptions);

    // First, add subscriptions without folders
    const noFolder = grouped.get(undefined);
    if (noFolder) {
      for (const sub of noFolder) {
        outlines.push(buildOutlineObject(sub));
      }
    }

    // Then, add folders with their subscriptions
    for (const [folder, subs] of grouped) {
      if (folder === undefined) continue;

      outlines.push({
        "@_text": folder,
        outline: subs.map((sub) => buildOutlineObject(sub)),
      });
    }
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

/**
 * Validates that a string is valid OPML.
 * Returns true if valid, false otherwise.
 */
export function isValidOpml(xml: string): boolean {
  try {
    parseOpml(xml);
    return true;
  } catch {
    return false;
  }
}

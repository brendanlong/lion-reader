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
 * Escapes special XML characters in text content.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
  const outlines: string[] = [];

  if (hasTagsFormat) {
    // New format: all feeds at top level + re-listed in tag folders
    // First, add ALL subscriptions at top level
    for (const sub of subscriptions) {
      outlines.push(buildOutlineElement(sub));
    }

    // Then, add tag folders with their subscriptions
    const tagGroups = groupByTags(subscriptions);
    // Sort tag folders alphabetically for consistent output
    const sortedTags = Array.from(tagGroups.keys()).sort();
    for (const tag of sortedTags) {
      const subs = tagGroups.get(tag)!;
      const folderOutlines = subs.map((sub) => buildOutlineElement(sub)).join("\n        ");
      outlines.push(`      <outline text="${escapeXml(tag)}">
        ${folderOutlines}
      </outline>`);
    }
  } else {
    // Legacy format: group by single folder
    const grouped = groupByFolder(subscriptions);

    // First, add subscriptions without folders
    const noFolder = grouped.get(undefined);
    if (noFolder) {
      for (const sub of noFolder) {
        outlines.push(buildOutlineElement(sub));
      }
    }

    // Then, add folders with their subscriptions
    for (const [folder, subs] of grouped) {
      if (folder === undefined) continue;

      const folderOutlines = subs.map((sub) => buildOutlineElement(sub)).join("\n        ");
      outlines.push(`      <outline text="${escapeXml(folder)}">
        ${folderOutlines}
      </outline>`);
    }
  }

  const title = metadata.title || "Lion Reader Subscriptions";
  const ownerName = metadata.ownerName
    ? `<ownerName>${escapeXml(metadata.ownerName)}</ownerName>`
    : "";
  const ownerEmail = metadata.ownerEmail
    ? `<ownerEmail>${escapeXml(metadata.ownerEmail)}</ownerEmail>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${escapeXml(title)}</title>
    <dateCreated>${dateCreated}</dateCreated>
    ${ownerName}
    ${ownerEmail}
  </head>
  <body>
${outlines.map((o) => (o.startsWith("      ") ? o : "      " + o)).join("\n")}
  </body>
</opml>`;
}

/**
 * Builds a single outline element for a subscription.
 */
function buildOutlineElement(sub: OpmlSubscription): string {
  const attrs: string[] = [
    `type="rss"`,
    `text="${escapeXml(sub.title)}"`,
    `title="${escapeXml(sub.title)}"`,
    `xmlUrl="${escapeXml(sub.xmlUrl)}"`,
  ];

  if (sub.htmlUrl) {
    attrs.push(`htmlUrl="${escapeXml(sub.htmlUrl)}"`);
  }

  return `<outline ${attrs.join(" ")} />`;
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

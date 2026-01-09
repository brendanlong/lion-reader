/**
 * OPML (Outline Processor Markup Language) parser and generator.
 * Handles importing and exporting feed subscriptions in the standard OPML format.
 *
 * OPML is an XML format commonly used for exchanging lists of RSS/Atom feeds
 * between feed readers. It supports nested folders/categories through nested
 * outline elements.
 *
 * @see http://opml.org/spec2.opml
 */

import { XMLParser } from "fast-xml-parser";

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
 * Parsed outline element from OPML.
 */
interface ParsedOutline {
  "@_text"?: string;
  "@_title"?: string;
  "@_type"?: string;
  "@_xmlUrl"?: string;
  "@_htmlUrl"?: string;
  "@_category"?: string;
  outline?: ParsedOutline | ParsedOutline[];
}

/**
 * Parsed OPML body structure from fast-xml-parser.
 * Can be an empty string for empty <body></body> elements.
 */
interface ParsedOpmlBody {
  outline?: ParsedOutline | ParsedOutline[];
}

/**
 * Parsed OPML structure from fast-xml-parser.
 */
interface ParsedOpml {
  opml?: {
    "@_version"?: string;
    head?: {
      title?: string;
      ownerName?: string;
      ownerEmail?: string;
      dateCreated?: string;
    };
    // fast-xml-parser returns "" for empty elements like <body></body>
    body?: ParsedOpmlBody | "";
  };
}

/**
 * Options for configuring the XML parser for OPML.
 */
const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Handle CDATA sections
  cdataPropName: "__cdata",
  // Preserve text content
  textNodeName: "#text",
  // Parse tag value
  parseTagValue: true,
  // Trim whitespace
  trimValues: true,
  // Handle namespace prefixes
  removeNSPrefix: false,
};

/**
 * Recursively processes outline elements to extract feeds.
 * Handles nested folders by tracking the category path.
 *
 * @param outline - The outline element(s) to process
 * @param categoryPath - Current category path (for nested folders)
 * @returns Array of parsed feeds
 */
function processOutlines(
  outline: ParsedOutline | ParsedOutline[] | undefined,
  categoryPath: string[] = []
): OpmlFeed[] {
  if (!outline) {
    return [];
  }

  const outlines = Array.isArray(outline) ? outline : [outline];
  const feeds: OpmlFeed[] = [];

  for (const item of outlines) {
    const xmlUrl = item["@_xmlUrl"];
    const type = item["@_type"]?.toLowerCase();
    const text = item["@_text"] || item["@_title"];

    // Check if this is a feed (has xmlUrl) or if it's an RSS/Atom type
    if (xmlUrl) {
      // This is a feed
      const feed: OpmlFeed = {
        xmlUrl,
        title: text,
        htmlUrl: item["@_htmlUrl"],
      };

      // Set category from path or from category attribute
      if (categoryPath.length > 0) {
        feed.category = [...categoryPath];
      } else if (item["@_category"]) {
        // Handle comma-separated categories or slash-separated paths
        const categoryAttr = item["@_category"];
        if (categoryAttr.includes("/")) {
          feed.category = categoryAttr.split("/").map((c) => c.trim());
        } else if (categoryAttr.includes(",")) {
          // Take first category if comma-separated
          feed.category = [categoryAttr.split(",")[0].trim()];
        } else {
          feed.category = [categoryAttr.trim()];
        }
      }

      feeds.push(feed);
    } else if (item.outline && !type) {
      // This is a folder (has nested outlines but no xmlUrl and no type like "rss")
      // Add this folder to the category path and process children
      const folderName = text;
      const newPath = folderName ? [...categoryPath, folderName] : categoryPath;
      const nestedFeeds = processOutlines(item.outline, newPath);
      feeds.push(...nestedFeeds);
    } else if (item.outline) {
      // Has children but might be some other type - still process children
      const nestedFeeds = processOutlines(item.outline, categoryPath);
      feeds.push(...nestedFeeds);
    }
  }

  return feeds;
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
  const parser = new XMLParser(parserOptions);

  let parsed: ParsedOpml;
  try {
    parsed = parser.parse(xml) as ParsedOpml;
  } catch (error) {
    throw new OpmlParseError(
      `Failed to parse XML: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }

  if (!parsed.opml) {
    throw new OpmlParseError("Invalid OPML: missing opml element");
  }

  // Check if body element exists in the XML
  // fast-xml-parser may return an empty string "" for empty elements like <body></body>
  // or undefined if body is completely missing
  const body = parsed.opml.body;
  if (body === undefined) {
    throw new OpmlParseError("Invalid OPML: missing body element");
  }

  // If body is empty (empty string or object without outline), return empty array
  if (body === "" || typeof body !== "object") {
    return [];
  }

  return processOutlines(body.outline);
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

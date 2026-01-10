/**
 * OPML (Outline Processor Markup Language) parser and generator.
 * Handles importing and exporting feed subscriptions in the standard OPML format.
 *
 * OPML is an XML format commonly used for exchanging lists of RSS/Atom feeds
 * between feed readers. It supports nested folders/categories through nested
 * outline elements.
 *
 * Internally uses streaming SAX parser for memory efficiency.
 *
 * @see http://opml.org/spec2.opml
 */

import {
  parseOpmlStream,
  OpmlStreamParseError,
  type OpmlFeed as StreamingOpmlFeed,
} from "./streaming";

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
export { OpmlStreamParseError as OpmlParseError };

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
  /** Category/folder name (optional) */
  folder?: string;
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
 * Converts a string to a ReadableStream of Uint8Array.
 */
function stringToStream(content: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(content);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

/**
 * Collects all feeds from the streaming OPML parser.
 */
async function collectFeeds(
  generator: AsyncGenerator<StreamingOpmlFeed, void, undefined>
): Promise<OpmlFeed[]> {
  const feeds: OpmlFeed[] = [];
  for await (const feed of generator) {
    feeds.push(feed);
  }
  return feeds;
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
 * const feeds = await parseOpml(opmlXml);
 * // [
 * //   { title: "Blog Name", xmlUrl: "https://...", category: ["Tech"] },
 * //   { title: "News", xmlUrl: "https://...", category: ["News", "Daily"] }
 * // ]
 * ```
 */
export async function parseOpml(xml: string): Promise<OpmlFeed[]> {
  const stream = stringToStream(xml);
  const result = await parseOpmlStream(stream);
  return collectFeeds(result.feeds);
}

/**
 * Groups subscriptions by folder.
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
 * @param subscriptions - Array of subscriptions to export
 * @param metadata - Optional document metadata
 * @returns OPML XML string
 *
 * @example
 * ```ts
 * const xml = generateOpml([
 *   { title: "Blog", xmlUrl: "https://blog.example.com/feed", folder: "Tech" },
 *   { title: "News", xmlUrl: "https://news.example.com/rss" }
 * ], { title: "My Subscriptions" });
 * ```
 */
export function generateOpml(
  subscriptions: OpmlSubscription[],
  metadata: OpmlMetadata = {}
): string {
  const grouped = groupByFolder(subscriptions);
  const dateCreated = new Date().toISOString();

  // Build outline elements
  const outlines: string[] = [];

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
export async function isValidOpml(xml: string): Promise<boolean> {
  try {
    await parseOpml(xml);
    return true;
  } catch {
    return false;
  }
}

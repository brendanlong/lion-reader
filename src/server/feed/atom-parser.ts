/**
 * Atom 1.0 feed parser.
 * Parses Atom feeds into a unified ParsedFeed format.
 */

import { XMLParser } from "fast-xml-parser";
import type { ParsedFeed, ParsedEntry, SyndicationHints } from "./types";

/**
 * Options for configuring the XML parser.
 * These options handle common Atom quirks like CDATA sections and attributes.
 */
const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Handle CDATA sections
  cdataPropName: "__cdata",
  // Preserve text content
  textNodeName: "#text",
  // Parse tag value - needed for handling nested structures
  parseTagValue: true,
  // Don't trim whitespace from text nodes
  trimValues: false,
  // Handle namespace prefixes
  removeNSPrefix: false,
};

/**
 * Decodes XML numeric character references that fast-xml-parser doesn't handle.
 * Handles both decimal (&#039;) and hexadecimal (&#x27;) forms.
 */
function decodeNumericEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

/**
 * Atom link element structure.
 */
interface AtomLink {
  "@_href"?: string;
  "@_rel"?: string;
  "@_type"?: string;
  "@_title"?: string;
}

/**
 * Atom text construct (title, summary, rights, subtitle).
 * Can be plain text, HTML, or XHTML.
 */
interface AtomTextConstruct {
  "@_type"?: "text" | "html" | "xhtml";
  "#text"?: string;
  __cdata?: string;
  div?: unknown; // XHTML content wrapped in div
}

/**
 * Atom content element.
 * Similar to text construct but with more type options.
 */
interface AtomContent {
  "@_type"?: string;
  "@_src"?: string;
  "#text"?: string;
  __cdata?: string;
  div?: unknown; // XHTML content wrapped in div
}

/**
 * Atom person construct (author, contributor).
 */
interface AtomPerson {
  name?: string | { "#text"?: string; __cdata?: string };
  email?: string | { "#text"?: string; __cdata?: string };
  uri?: string | { "#text"?: string; __cdata?: string };
}

/**
 * Parsed Atom entry structure from fast-xml-parser.
 */
interface AtomEntry {
  id?: string | { "#text"?: string; __cdata?: string };
  title?: string | AtomTextConstruct;
  link?: AtomLink | AtomLink[];
  summary?: string | AtomTextConstruct;
  content?: string | AtomContent;
  author?: AtomPerson | AtomPerson[];
  published?: string | { "#text"?: string };
  updated?: string | { "#text"?: string };
}

/**
 * Parsed Atom feed structure from fast-xml-parser.
 */
interface AtomFeed {
  id?: string | { "#text"?: string; __cdata?: string };
  title?: string | AtomTextConstruct;
  subtitle?: string | AtomTextConstruct;
  link?: AtomLink | AtomLink[];
  icon?: string | { "#text"?: string; __cdata?: string };
  logo?: string | { "#text"?: string; __cdata?: string };
  author?: AtomPerson | AtomPerson[];
  entry?: AtomEntry | AtomEntry[];
  /** Syndication namespace: update period (hourly, daily, weekly, monthly, yearly) */
  "sy:updatePeriod"?: string | { "#text"?: string };
  /** Syndication namespace: update frequency (number of times per period) */
  "sy:updateFrequency"?: string | number | { "#text"?: string | number };
}

/**
 * Parsed Atom document structure from fast-xml-parser.
 */
interface ParsedAtom {
  feed?: AtomFeed;
}

/**
 * Extracts text from various possible structures.
 * Handles plain strings, CDATA sections, and text constructs.
 * Decodes numeric character references (&#039; &#x27;) that the XML parser doesn't handle.
 */
function extractText(
  value: string | { __cdata?: string; "#text"?: string } | undefined
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  let text: string | undefined;
  if (typeof value === "string") {
    text = value;
  } else if (value.__cdata !== undefined) {
    // Handle CDATA wrapped content
    text = typeof value.__cdata === "string" ? value.__cdata : "";
  } else if (value["#text"] !== undefined) {
    // Handle text node
    text = typeof value["#text"] === "string" ? value["#text"] : "";
  }

  if (text === undefined) {
    return undefined;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  return decodeNumericEntities(trimmed);
}

/**
 * Extracts content from an Atom text construct (title, summary, etc).
 * Handles plain text, HTML, and XHTML types.
 * Decodes numeric character references.
 */
function extractTextConstruct(value: string | AtomTextConstruct | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  let text: string | undefined;

  if (typeof value === "string") {
    text = value;
  } else {
    const type = value["@_type"] || "text";

    // Handle XHTML - it's wrapped in a div element
    if (type === "xhtml" && value.div !== undefined) {
      // For XHTML, we'd need to serialize the div content
      // For now, return as JSON string if it's an object, or string if it's a string
      if (typeof value.div === "string") {
        text = value.div;
      } else {
        // Complex XHTML - serialize as best we can
        return JSON.stringify(value.div);
      }
    } else if (value.__cdata !== undefined) {
      // Handle CDATA wrapped content
      text = typeof value.__cdata === "string" ? value.__cdata : "";
    } else if (value["#text"] !== undefined) {
      // Handle text node (for html and text types)
      text = typeof value["#text"] === "string" ? value["#text"] : "";
    }
  }

  if (text === undefined) {
    return undefined;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  return decodeNumericEntities(trimmed);
}

/**
 * Extracts content from an Atom content element.
 * Similar to text construct but with src attribute support.
 * Decodes numeric character references.
 */
function extractContent(value: string | AtomContent | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  let text: string | undefined;

  if (typeof value === "string") {
    text = value;
  } else {
    // If content has src attribute, it's an out-of-line content
    // We can't fetch it here, so return undefined
    if (value["@_src"]) {
      return undefined;
    }

    const type = value["@_type"] || "text";

    // Handle XHTML - it's wrapped in a div element
    if (type === "xhtml" && value.div !== undefined) {
      if (typeof value.div === "string") {
        text = value.div;
      } else {
        // Complex XHTML - serialize as best we can
        return JSON.stringify(value.div);
      }
    } else if (value.__cdata !== undefined) {
      // Handle CDATA wrapped content
      text = typeof value.__cdata === "string" ? value.__cdata : "";
    } else if (value["#text"] !== undefined) {
      // Handle text node
      text = typeof value["#text"] === "string" ? value["#text"] : "";
    }
  }

  if (text === undefined) {
    return undefined;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  return decodeNumericEntities(trimmed);
}

/**
 * Extracts name from an Atom person construct (author, contributor).
 */
function extractPersonName(person: AtomPerson | AtomPerson[] | undefined): string | undefined {
  if (!person) {
    return undefined;
  }

  const firstPerson = Array.isArray(person) ? person[0] : person;
  if (!firstPerson) {
    return undefined;
  }

  return extractText(firstPerson.name);
}

/**
 * Valid update period values from the Syndication namespace.
 */
const VALID_UPDATE_PERIODS = ["hourly", "daily", "weekly", "monthly", "yearly"] as const;
type UpdatePeriod = (typeof VALID_UPDATE_PERIODS)[number];

/**
 * Extracts syndication namespace hints from Atom feed.
 */
function extractSyndicationHints(feed: AtomFeed): SyndicationHints | undefined {
  const periodRaw = feed["sy:updatePeriod"];
  const frequencyRaw = feed["sy:updateFrequency"];

  // If neither is present, return undefined
  if (periodRaw === undefined && frequencyRaw === undefined) {
    return undefined;
  }

  const hints: SyndicationHints = {};

  // Extract period
  if (periodRaw !== undefined) {
    let periodValue: string | undefined;
    if (typeof periodRaw === "string") {
      periodValue = periodRaw;
    } else if (periodRaw["#text"] !== undefined) {
      periodValue = periodRaw["#text"];
    }

    if (periodValue) {
      const normalized = periodValue.toLowerCase().trim() as UpdatePeriod;
      if (VALID_UPDATE_PERIODS.includes(normalized)) {
        hints.updatePeriod = normalized;
      }
    }
  }

  // Extract frequency
  if (frequencyRaw !== undefined) {
    let freqValue: string | number | undefined;
    if (typeof frequencyRaw === "string" || typeof frequencyRaw === "number") {
      freqValue = frequencyRaw;
    } else if (frequencyRaw["#text"] !== undefined) {
      freqValue = frequencyRaw["#text"];
    }

    if (freqValue !== undefined) {
      const parsed =
        typeof freqValue === "number" ? freqValue : parseInt(String(freqValue).trim(), 10);
      if (!isNaN(parsed) && parsed > 0) {
        hints.updateFrequency = parsed;
      }
    }
  }

  // Only return if we got at least one valid hint
  if (hints.updatePeriod !== undefined || hints.updateFrequency !== undefined) {
    return hints;
  }

  return undefined;
}

/**
 * Extracts a specific link by rel attribute from Atom link elements.
 * Returns the first matching link's href.
 */
function extractLinkByRel(
  links: AtomLink | AtomLink[] | undefined,
  rel: string
): string | undefined {
  if (!links) {
    return undefined;
  }

  const linkArray = Array.isArray(links) ? links : [links];
  for (const link of linkArray) {
    if (link["@_rel"] === rel && link["@_href"]) {
      return link["@_href"];
    }
  }
  return undefined;
}

/**
 * Extracts the alternate link (main entry/feed link) from Atom link elements.
 * If no rel is specified, it defaults to "alternate".
 */
function extractAlternateLink(links: AtomLink | AtomLink[] | undefined): string | undefined {
  if (!links) {
    return undefined;
  }

  const linkArray = Array.isArray(links) ? links : [links];

  // First, try to find an explicit "alternate" link
  for (const link of linkArray) {
    if (link["@_rel"] === "alternate" && link["@_href"]) {
      return link["@_href"];
    }
  }

  // If no explicit alternate, find link with no rel (defaults to alternate)
  for (const link of linkArray) {
    if (!link["@_rel"] && link["@_href"]) {
      return link["@_href"];
    }
  }

  return undefined;
}

/**
 * Parses various date formats commonly found in Atom feeds.
 * Atom uses RFC 3339 (a profile of ISO 8601), but we handle variations.
 * Returns undefined if the date cannot be parsed.
 */
export function parseAtomDate(
  dateString: string | { "#text"?: string } | undefined
): Date | undefined {
  if (!dateString) {
    return undefined;
  }

  const str = typeof dateString === "string" ? dateString : dateString["#text"];
  if (!str || typeof str !== "string") {
    return undefined;
  }

  const trimmed = str.trim();
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

/**
 * Parses an Atom entry into a ParsedEntry.
 */
function parseAtomEntry(entry: AtomEntry): ParsedEntry {
  // Prefer content over summary for full content
  const content = extractContent(entry.content) || extractTextConstruct(entry.summary);
  const summary = extractTextConstruct(entry.summary);

  // Prefer published date, fall back to updated
  const pubDate = parseAtomDate(entry.published) || parseAtomDate(entry.updated);

  return {
    guid: extractText(entry.id),
    link: extractAlternateLink(entry.link),
    title: extractTextConstruct(entry.title),
    author: extractPersonName(entry.author),
    content,
    summary,
    pubDate,
  };
}

/**
 * Parses an Atom 1.0 feed XML string into a ParsedFeed.
 *
 * @param xml - The Atom feed XML content as a string
 * @returns A ParsedFeed object with normalized feed data
 * @throws Error if the XML is not a valid Atom feed
 */
export function parseAtomFeed(xml: string): ParsedFeed {
  const parser = new XMLParser(parserOptions);
  const parsed = parser.parse(xml) as ParsedAtom;

  const feed = parsed.feed;
  if (!feed) {
    throw new Error("Invalid Atom feed: missing feed element");
  }

  // Extract feed title
  const title = extractTextConstruct(feed.title);
  if (!title) {
    throw new Error("Invalid Atom feed: missing title");
  }

  // Normalize entries to array
  let entries: AtomEntry[] = [];
  if (feed.entry) {
    entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];
  }

  // Extract icon - prefer icon over logo (icon is smaller, like favicon)
  const iconUrl = extractText(feed.icon) || extractText(feed.logo);

  return {
    title,
    description: extractTextConstruct(feed.subtitle),
    siteUrl: extractAlternateLink(feed.link),
    iconUrl,
    items: entries.map(parseAtomEntry),
    hubUrl: extractLinkByRel(feed.link, "hub"),
    selfUrl: extractLinkByRel(feed.link, "self"),
    syndication: extractSyndicationHints(feed),
  };
}

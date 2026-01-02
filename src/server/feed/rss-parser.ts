/**
 * RSS 2.0 feed parser.
 * Parses RSS 2.0 feeds into a unified ParsedFeed format.
 */

import { XMLParser } from "fast-xml-parser";
import type { ParsedFeed, ParsedEntry, SyndicationHints } from "./types";

/**
 * Options for configuring the XML parser.
 * These options handle common RSS quirks like CDATA sections and attributes.
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
  // Handle namespace prefixes (like dc:creator, content:encoded)
  removeNSPrefix: false,
};

/**
 * Parsed RSS channel structure from fast-xml-parser.
 * This represents the raw parsed XML structure before normalization.
 */
interface RssChannel {
  title?: string | { __cdata?: string; "#text"?: string };
  link?: string | string[] | { "@_href"?: string; "#text"?: string }[];
  description?: string | { __cdata?: string; "#text"?: string };
  image?: {
    url?: string;
  };
  "atom:link"?: { "@_rel"?: string; "@_href"?: string } | { "@_rel"?: string; "@_href"?: string }[];
  item?: RssItem | RssItem[];
  /** RSS 2.0 TTL element - time to live in minutes */
  ttl?: string | number | { "#text"?: string | number };
  /** Syndication namespace: update period (hourly, daily, weekly, monthly, yearly) */
  "sy:updatePeriod"?: string | { "#text"?: string };
  /** Syndication namespace: update frequency (number of times per period) */
  "sy:updateFrequency"?: string | number | { "#text"?: string | number };
}

/**
 * Parsed RSS item structure from fast-xml-parser.
 */
interface RssItem {
  title?: string | { __cdata?: string; "#text"?: string };
  link?: string | { __cdata?: string; "#text"?: string };
  description?: string | { __cdata?: string; "#text"?: string };
  pubDate?: string;
  "dc:date"?: string | { __cdata?: string; "#text"?: string };
  guid?: string | { "#text"?: string; "@_isPermaLink"?: string; __cdata?: string };
  author?: string | { __cdata?: string; "#text"?: string };
  "dc:creator"?: string | { __cdata?: string; "#text"?: string };
  "content:encoded"?: string | { __cdata?: string; "#text"?: string };
  enclosure?: {
    "@_url"?: string;
    "@_type"?: string;
    "@_length"?: string;
  };
}

/**
 * Parsed RSS structure from fast-xml-parser.
 */
interface ParsedRss {
  rss?: {
    channel?: RssChannel;
  };
  // Some feeds have rdf:RDF at the root (RSS 1.0)
  "rdf:RDF"?: {
    channel?: RssChannel;
    item?: RssItem | RssItem[];
  };
}

/**
 * Extracts text content from various possible structures.
 * Handles plain strings, CDATA sections, and nested text nodes.
 */
function extractText(
  value: string | { __cdata?: string; "#text"?: string } | undefined
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  // Handle CDATA wrapped content
  if (value.__cdata !== undefined) {
    return (typeof value.__cdata === "string" ? value.__cdata : "").trim() || undefined;
  }
  // Handle text node
  if (value["#text"] !== undefined) {
    return (typeof value["#text"] === "string" ? value["#text"] : "").trim() || undefined;
  }
  return undefined;
}

/**
 * Extracts the GUID from an RSS item.
 * The guid element can be a plain string or an object with text and attributes.
 */
function extractGuid(
  guid: string | { "#text"?: string; "@_isPermaLink"?: string; __cdata?: string } | undefined
): string | undefined {
  if (guid === undefined || guid === null) {
    return undefined;
  }
  if (typeof guid === "string") {
    return guid.trim() || undefined;
  }
  // Handle object with #text property
  if (guid["#text"] !== undefined) {
    return (typeof guid["#text"] === "string" ? guid["#text"] : "").trim() || undefined;
  }
  // Handle CDATA
  if (guid.__cdata !== undefined) {
    return (typeof guid.__cdata === "string" ? guid.__cdata : "").trim() || undefined;
  }
  return undefined;
}

/**
 * Extracts the link from an RSS item or channel.
 * Handles various link formats including arrays and atom:link elements.
 */
function extractLink(
  link: string | { __cdata?: string; "#text"?: string } | undefined
): string | undefined {
  if (link === undefined || link === null) {
    return undefined;
  }
  if (typeof link === "string") {
    return link.trim() || undefined;
  }
  if (link.__cdata !== undefined) {
    return (typeof link.__cdata === "string" ? link.__cdata : "").trim() || undefined;
  }
  if (link["#text"] !== undefined) {
    return (typeof link["#text"] === "string" ? link["#text"] : "").trim() || undefined;
  }
  return undefined;
}

/**
 * Extracts the site URL from the channel's link element.
 * The link element can be a string, array, or atom:link object.
 */
function extractChannelLink(
  link: string | string[] | { "@_href"?: string; "#text"?: string }[] | undefined
): string | undefined {
  if (link === undefined || link === null) {
    return undefined;
  }
  if (typeof link === "string") {
    return link.trim() || undefined;
  }
  if (Array.isArray(link)) {
    // Return the first string link
    for (const l of link) {
      if (typeof l === "string") {
        return l.trim() || undefined;
      }
      if (typeof l === "object" && l["#text"]) {
        return l["#text"].trim() || undefined;
      }
    }
  }
  return undefined;
}

/**
 * Parses various date formats commonly found in RSS feeds.
 * Returns undefined if the date cannot be parsed.
 */
export function parseRssDate(dateString: string | undefined): Date | undefined {
  if (!dateString || typeof dateString !== "string") {
    return undefined;
  }

  const trimmed = dateString.trim();
  if (!trimmed) {
    return undefined;
  }

  // Try native Date parsing first (handles ISO 8601 and RFC 2822)
  const nativeDate = new Date(trimmed);
  if (!isNaN(nativeDate.getTime())) {
    return nativeDate;
  }

  // Try some common non-standard formats

  // Handle "DD Mon YYYY HH:MM:SS" format (missing timezone)
  const ddMonYyyy = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/;
  const match = trimmed.match(ddMonYyyy);
  if (match) {
    const parsed = new Date(
      `${match[2]} ${match[1]}, ${match[3]} ${match[4]}:${match[5]}:${match[6]} GMT`
    );
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  // Handle dates with extra timezone info like "PST" or "EST"
  // Replace common timezone abbreviations with offsets
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

  let normalized = trimmed;
  for (const [abbr, offset] of Object.entries(timezoneMap)) {
    if (trimmed.includes(abbr)) {
      normalized = trimmed.replace(abbr, offset);
      const parsed = new Date(normalized);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  }

  return undefined;
}

/**
 * Extracts TTL (time to live) value from RSS channel.
 * Returns the value in minutes, or undefined if not present/invalid.
 */
function extractTtl(
  ttl: string | number | { "#text"?: string | number } | undefined
): number | undefined {
  if (ttl === undefined || ttl === null) {
    return undefined;
  }

  let value: string | number | undefined;
  if (typeof ttl === "string" || typeof ttl === "number") {
    value = ttl;
  } else if (ttl["#text"] !== undefined) {
    value = ttl["#text"];
  }

  if (value === undefined) {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : parseInt(String(value).trim(), 10);
  if (isNaN(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

/**
 * Valid update period values from the Syndication namespace.
 */
const VALID_UPDATE_PERIODS = ["hourly", "daily", "weekly", "monthly", "yearly"] as const;
type UpdatePeriod = (typeof VALID_UPDATE_PERIODS)[number];

/**
 * Extracts syndication namespace hints from RSS channel.
 */
function extractSyndicationHints(channel: RssChannel): SyndicationHints | undefined {
  const periodRaw = channel["sy:updatePeriod"];
  const frequencyRaw = channel["sy:updateFrequency"];

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
 * Extracts WebSub hub URL from atom:link elements.
 */
function extractHubUrl(
  atomLink:
    | { "@_rel"?: string; "@_href"?: string }
    | { "@_rel"?: string; "@_href"?: string }[]
    | undefined
): string | undefined {
  if (!atomLink) {
    return undefined;
  }
  const links = Array.isArray(atomLink) ? atomLink : [atomLink];
  for (const link of links) {
    if (link["@_rel"] === "hub" && link["@_href"]) {
      return link["@_href"];
    }
  }
  return undefined;
}

/**
 * Extracts self URL from atom:link elements.
 */
function extractSelfUrl(
  atomLink:
    | { "@_rel"?: string; "@_href"?: string }
    | { "@_rel"?: string; "@_href"?: string }[]
    | undefined
): string | undefined {
  if (!atomLink) {
    return undefined;
  }
  const links = Array.isArray(atomLink) ? atomLink : [atomLink];
  for (const link of links) {
    if (link["@_rel"] === "self" && link["@_href"]) {
      return link["@_href"];
    }
  }
  return undefined;
}

/**
 * Parses an RSS item into a ParsedEntry.
 */
function parseRssItem(item: RssItem): ParsedEntry {
  // Prefer content:encoded over description for full content
  const content = extractText(item["content:encoded"]) || extractText(item.description);
  const summary = extractText(item.description);

  // Prefer dc:creator over author for author name
  const author = extractText(item["dc:creator"]) || extractText(item.author);

  // Prefer pubDate (RSS 2.0) over dc:date (RSS 1.0/Dublin Core)
  const pubDate = parseRssDate(item.pubDate) || parseRssDate(extractText(item["dc:date"]));

  return {
    guid: extractGuid(item.guid),
    link: extractLink(item.link),
    title: extractText(item.title),
    author,
    content,
    summary,
    pubDate,
  };
}

/**
 * Parses an RSS 2.0 feed XML string into a ParsedFeed.
 *
 * @param xml - The RSS feed XML content as a string
 * @returns A ParsedFeed object with normalized feed data
 * @throws Error if the XML is not a valid RSS feed
 */
export function parseRssFeed(xml: string): ParsedFeed {
  const parser = new XMLParser(parserOptions);
  const parsed = parser.parse(xml) as ParsedRss;

  // Get channel from rss or rdf:RDF (RSS 1.0)
  const channel = parsed.rss?.channel || parsed["rdf:RDF"]?.channel;
  if (!channel) {
    throw new Error("Invalid RSS feed: missing channel element");
  }

  // For RSS 1.0, items are at the rdf:RDF level, not in channel
  const rawItems = channel.item || parsed["rdf:RDF"]?.item;

  // Normalize items to array
  let items: RssItem[] = [];
  if (rawItems) {
    items = Array.isArray(rawItems) ? rawItems : [rawItems];
  }

  // Extract feed metadata
  const title = extractText(channel.title);
  if (!title) {
    throw new Error("Invalid RSS feed: missing title");
  }

  return {
    title,
    description: extractText(channel.description),
    siteUrl: extractChannelLink(channel.link),
    iconUrl: channel.image?.url,
    items: items.map(parseRssItem),
    hubUrl: extractHubUrl(channel["atom:link"]),
    selfUrl: extractSelfUrl(channel["atom:link"]),
    ttlMinutes: extractTtl(channel.ttl),
    syndication: extractSyndicationHints(channel),
  };
}

/**
 * Streaming JSON Feed 1.1 parser.
 * Parses JSON Feed from a ReadableStream, yielding entries via async generator.
 */

import type { ParsedEntry } from "../types";
import type { StreamingFeedResult } from "./types";

interface JsonFeedAuthor {
  name?: string;
  url?: string;
  avatar?: string;
}

interface JsonFeedHub {
  type: string;
  url: string;
}

interface JsonFeedItem {
  id: string;
  url?: string;
  external_url?: string;
  title?: string;
  content_html?: string;
  content_text?: string;
  summary?: string;
  image?: string;
  banner_image?: string;
  date_published?: string;
  date_modified?: string;
  authors?: JsonFeedAuthor[];
  author?: JsonFeedAuthor;
  tags?: string[];
  language?: string;
}

function extractAuthor(item: JsonFeedItem): string | undefined {
  if (item.authors && item.authors.length > 0 && item.authors[0].name) {
    return item.authors[0].name;
  }
  return item.author?.name;
}

function parseJsonFeedDate(dateString: string | undefined): Date | undefined {
  if (!dateString || typeof dateString !== "string") return undefined;
  const trimmed = dateString.trim();
  if (!trimmed) return undefined;
  const date = new Date(trimmed);
  return isNaN(date.getTime()) ? undefined : date;
}

function parseJsonFeedItem(item: JsonFeedItem): ParsedEntry {
  return {
    guid: item.id,
    link: item.url || item.external_url,
    title: item.title,
    author: extractAuthor(item),
    content: item.content_html || item.content_text,
    summary: item.summary || item.content_text,
    pubDate: parseJsonFeedDate(item.date_published) || parseJsonFeedDate(item.date_modified),
  };
}

function extractHubUrl(hubs: JsonFeedHub[] | undefined): string | undefined {
  if (!hubs || hubs.length === 0) return undefined;
  for (const hub of hubs) {
    if (hub.type === "websub" && hub.url) return hub.url;
  }
  return hubs[0].url;
}

/**
 * Parses a JSON Feed from a ReadableStream.
 * Returns immediately with metadata; entries are yielded via async generator.
 */
export async function parseJsonStream(
  stream: ReadableStream<Uint8Array>
): Promise<StreamingFeedResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }

  const jsonString = chunks.join("");
  const parsed = JSON.parse(jsonString) as Record<string, unknown>;

  // Validate
  if (
    typeof parsed.version !== "string" ||
    !parsed.version.startsWith("https://jsonfeed.org/version/")
  ) {
    throw new Error("Invalid JSON Feed: missing or invalid version");
  }

  if (!Array.isArray(parsed.items)) {
    throw new Error("Invalid JSON Feed: missing items array");
  }

  const items = parsed.items as JsonFeedItem[];
  let index = 0;

  async function* entriesGenerator(): AsyncGenerator<ParsedEntry, void, undefined> {
    while (index < items.length) {
      yield parseJsonFeedItem(items[index++]);
    }
  }

  return {
    title: typeof parsed.title === "string" ? parsed.title.trim() || undefined : undefined,
    description:
      typeof parsed.description === "string" ? parsed.description.trim() || undefined : undefined,
    siteUrl: typeof parsed.home_page_url === "string" ? parsed.home_page_url : undefined,
    iconUrl:
      typeof parsed.favicon === "string"
        ? parsed.favicon
        : typeof parsed.icon === "string"
          ? parsed.icon
          : undefined,
    hubUrl: extractHubUrl(parsed.hubs as JsonFeedHub[] | undefined),
    selfUrl: typeof parsed.feed_url === "string" ? parsed.feed_url : undefined,
    entries: entriesGenerator(),
  };
}

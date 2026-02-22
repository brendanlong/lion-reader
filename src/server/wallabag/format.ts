/**
 * Wallabag API Response Formatting
 *
 * Transforms Lion Reader data into the JSON format expected by Wallabag clients.
 *
 * Wallabag entries have numeric integer IDs. We derive a deterministic
 * 32-bit positive integer from UUIDv7 to avoid needing a mapping table.
 * This uses a different strategy than Google Reader (which needs 64-bit)
 * because Wallabag IDs are simpler integers.
 */

import { createHash } from "crypto";
import type { EntryFull, EntryListItem } from "@/server/services/entries";
import type { SavedArticle } from "@/server/services/saved";
import type { ListTagsResult } from "@/server/services/tags";

// ============================================================================
// ID Conversion
// ============================================================================

/**
 * Converts a UUIDv7 to a stable positive integer ID for Wallabag.
 *
 * Uses first 4 bytes of SHA-256 hash of the UUID, masked to 31 bits
 * to ensure a positive signed 32-bit integer.
 */
export function uuidToWallabagId(uuid: string): number {
  const hash = createHash("sha256").update(uuid).digest();
  // Read first 4 bytes as unsigned 32-bit integer, mask to 31 bits for positive value
  return hash.readUInt32BE(0) & 0x7fffffff;
}

// ============================================================================
// Entry Formatting
// ============================================================================

export interface WallabagEntry {
  id: number;
  url: string | null;
  title: string | null;
  content: string | null;
  is_archived: 0 | 1;
  is_starred: 0 | 1;
  is_public: boolean;
  tags: WallabagTag[];
  created_at: string;
  updated_at: string;
  published_at: string | null;
  published_by: string[] | null;
  domain_name: string | null;
  reading_time: number;
  preview_picture: string | null;
  mimetype: string | null;
  language: string | null;
  uid: string;
  /** The Lion Reader UUID - used for reverse lookups */
  _lion_reader_id: string;
}

/**
 * Estimates reading time in minutes from HTML content.
 * Assumes ~200 words per minute reading speed.
 */
function estimateReadingTime(content: string | null): number {
  if (!content) return 0;
  // Strip HTML tags and count words
  const text = content.replace(/<[^>]*>/g, " ").trim();
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(wordCount / 200));
}

/**
 * Extracts domain from URL.
 */
function extractDomain(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Formats a date for Wallabag (ISO 8601).
 */
function formatDate(date: Date | null): string | null {
  if (!date) return null;
  return date.toISOString();
}

/**
 * Formats a full entry as a Wallabag entry.
 */
export function formatEntryFull(entry: EntryFull): WallabagEntry {
  const content = entry.contentCleaned ?? entry.contentOriginal ?? entry.summary ?? null;

  return {
    id: uuidToWallabagId(entry.id),
    url: entry.url,
    title: entry.title,
    content,
    is_archived: entry.read ? 1 : 0,
    is_starred: entry.starred ? 1 : 0,
    is_public: false,
    tags: [],
    created_at: formatDate(entry.fetchedAt)!,
    updated_at: formatDate(entry.updatedAt)!,
    published_at: formatDate(entry.publishedAt),
    published_by: entry.author ? [entry.author] : null,
    domain_name: extractDomain(entry.url),
    reading_time: estimateReadingTime(content),
    preview_picture: null,
    mimetype: "text/html",
    language: null,
    uid: entry.id,
    _lion_reader_id: entry.id,
  };
}

/**
 * Formats a list entry as a Wallabag entry (no full content).
 */
export function formatEntryListItem(entry: EntryListItem): WallabagEntry {
  return {
    id: uuidToWallabagId(entry.id),
    url: entry.url,
    title: entry.title,
    content: entry.summary ?? null,
    is_archived: entry.read ? 1 : 0,
    is_starred: entry.starred ? 1 : 0,
    is_public: false,
    tags: [],
    created_at: formatDate(entry.fetchedAt)!,
    updated_at: formatDate(entry.updatedAt)!,
    published_at: formatDate(entry.publishedAt),
    published_by: entry.author ? [entry.author] : null,
    domain_name: extractDomain(entry.url),
    reading_time: estimateReadingTime(entry.summary),
    preview_picture: null,
    mimetype: "text/html",
    language: null,
    uid: entry.id,
    _lion_reader_id: entry.id,
  };
}

/**
 * Formats a saved article as a Wallabag entry.
 */
export function formatSavedArticle(article: SavedArticle): WallabagEntry {
  return {
    id: uuidToWallabagId(article.id),
    url: article.url,
    title: article.title,
    content: article.contentCleaned ?? article.excerpt ?? null,
    is_archived: article.read ? 1 : 0,
    is_starred: article.starred ? 1 : 0,
    is_public: false,
    tags: [],
    created_at: formatDate(article.savedAt)!,
    updated_at: formatDate(article.savedAt)!,
    published_at: null,
    published_by: article.author ? [article.author] : null,
    domain_name: extractDomain(article.url),
    reading_time: estimateReadingTime(article.contentCleaned),
    preview_picture: article.imageUrl,
    mimetype: "text/html",
    language: null,
    uid: article.id,
    _lion_reader_id: article.id,
  };
}

// ============================================================================
// Tag Formatting
// ============================================================================

export interface WallabagTag {
  id: number;
  label: string;
  slug: string;
}

/**
 * Formats tags for Wallabag.
 */
export function formatTags(tagsResult: ListTagsResult): WallabagTag[] {
  return tagsResult.items.map((tag) => ({
    id: uuidToWallabagId(tag.id),
    label: tag.name,
    slug: tag.name.toLowerCase().replace(/\s+/g, "-"),
  }));
}

// ============================================================================
// Paginated Response
// ============================================================================

export interface WallabagPaginatedResponse {
  page: number;
  limit: number;
  pages: number;
  total: number;
  _embedded: {
    items: WallabagEntry[];
  };
  _links: {
    self: { href: string };
    first: { href: string };
    last: { href: string };
    next?: { href: string };
  };
}

/**
 * Creates a paginated Wallabag response.
 */
export function createPaginatedResponse(
  items: WallabagEntry[],
  page: number,
  perPage: number,
  total: number,
  baseUrl: string
): WallabagPaginatedResponse {
  const pages = Math.max(1, Math.ceil(total / perPage));

  const response: WallabagPaginatedResponse = {
    page,
    limit: perPage,
    pages,
    total,
    _embedded: { items },
    _links: {
      self: { href: `${baseUrl}?page=${page}&perPage=${perPage}` },
      first: { href: `${baseUrl}?page=1&perPage=${perPage}` },
      last: { href: `${baseUrl}?page=${pages}&perPage=${perPage}` },
    },
  };

  if (page < pages) {
    response._links.next = { href: `${baseUrl}?page=${page + 1}&perPage=${perPage}` };
  }

  return response;
}

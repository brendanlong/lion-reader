/**
 * Wallabag API Response Formatting
 *
 * Transforms Lion Reader data into the JSON format expected by Wallabag clients.
 *
 * Wallabag entries have numeric integer IDs. Every id a client sees is a
 * stored serial (issue #1117): entry ids are `entries.greader_item_id` (the
 * same global serial the Google Reader API uses for item ids, carried on
 * `EntryFull`/`EntryListItem` as `greaderItemId`), tag ids are
 * `tags.greader_sortid`, and the user id is `users.greader_user_id`. Only
 * entry ids are ever reversed (see src/server/wallabag/id.ts); tag and user
 * ids are opaque.
 */

import type { EntryFull, EntryListItem } from "@/server/services/entries";
import type { SavedArticle } from "@/server/services/saved";

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
 * The fields that vary between our entry shapes (full entry, list item, saved
 * article); everything else in a Wallabag entry is derived or constant.
 */
interface WallabagEntryInput {
  id: string;
  /** Wallabag integer id — the entry's stored serial (`entries.greader_item_id`). */
  wallabagId: number;
  url: string | null;
  title: string | null;
  content: string | null;
  read: boolean;
  starred: boolean;
  author: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  publishedAt: Date | null;
  previewPicture: string | null;
}

/**
 * Builds a Wallabag entry from the varying fields, deriving the constant and
 * computed ones (archived/starred flags, domain, reading time). This is the
 * single place the Wallabag entry shape is assembled, so the three format*
 * helpers below can't drift.
 */
function buildWallabagEntry(input: WallabagEntryInput): WallabagEntry {
  return {
    id: input.wallabagId,
    url: input.url,
    title: input.title,
    content: input.content,
    is_archived: input.read ? 1 : 0,
    is_starred: input.starred ? 1 : 0,
    is_public: false,
    tags: [],
    created_at: formatDate(input.createdAt)!,
    updated_at: formatDate(input.updatedAt)!,
    published_at: formatDate(input.publishedAt),
    published_by: input.author ? [input.author] : null,
    domain_name: extractDomain(input.url),
    reading_time: estimateReadingTime(input.content),
    preview_picture: input.previewPicture,
    mimetype: "text/html",
    language: null,
    uid: input.id,
    _lion_reader_id: input.id,
  };
}

/**
 * Formats a full entry as a Wallabag entry.
 */
export function formatEntryFull(entry: EntryFull): WallabagEntry {
  return buildWallabagEntry({
    id: entry.id,
    wallabagId: Number(entry.greaderItemId),
    url: entry.url,
    title: entry.title,
    content: entry.contentCleaned ?? entry.contentOriginal ?? entry.summary ?? null,
    read: entry.read,
    starred: entry.starred,
    author: entry.author,
    createdAt: entry.fetchedAt,
    updatedAt: entry.updatedAt,
    publishedAt: entry.publishedAt,
    previewPicture: null,
  });
}

/**
 * Formats a list entry as a Wallabag entry (no full content).
 */
export function formatEntryListItem(entry: EntryListItem): WallabagEntry {
  return buildWallabagEntry({
    id: entry.id,
    wallabagId: Number(entry.greaderItemId),
    url: entry.url,
    title: entry.title,
    content: entry.summary ?? null,
    read: entry.read,
    starred: entry.starred,
    author: entry.author,
    createdAt: entry.fetchedAt,
    updatedAt: entry.updatedAt,
    publishedAt: entry.publishedAt,
    previewPicture: null,
  });
}

/**
 * Formats a saved article as a Wallabag entry. `SavedArticle` deliberately
 * doesn't carry the entry serial (it's returned verbatim by MCP save_article,
 * which must stay bigint-free), so the caller passes the Wallabag id looked up
 * via `entryIdToWallabagId`.
 */
export function formatSavedArticle(article: SavedArticle, wallabagId: number): WallabagEntry {
  return buildWallabagEntry({
    id: article.id,
    wallabagId,
    url: article.url,
    title: article.title,
    content: article.contentCleaned ?? article.excerpt ?? null,
    read: article.read,
    starred: article.starred,
    author: article.author,
    createdAt: article.savedAt,
    updatedAt: article.savedAt,
    publishedAt: null,
    previewPicture: article.imageUrl,
  });
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
 * Formats tags for Wallabag. A tag's id is its stored serial
 * (`tags.greader_sortid`), opaque to clients — the Wallabag surface never
 * reverses tag ids (the tags route is list-only).
 */
export function formatTags(
  userTags: Array<{ name: string; greaderSortid: bigint }>
): WallabagTag[] {
  return userTags.map((tag) => ({
    id: Number(tag.greaderSortid),
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

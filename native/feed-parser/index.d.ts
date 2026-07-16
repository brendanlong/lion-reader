/**
 * Hand-maintained typings for the native feed parser (see src/lib.rs). Keep
 * in lockstep with the #[napi] exports.
 */

export interface DateCandidate {
  /**
   * `true` for the primary date element (RSS `pubDate`, Atom `published`): a
   * successfully-parsed value overwrites any previously selected date.
   * `false` for the fallback element (RSS `dc:date`, Atom `updated`): it
   * applies only while no date has been selected yet.
   */
  primary: boolean;
  value: string;
}

export interface RawParsedEntry {
  guid?: string;
  link?: string;
  title?: string;
  author?: string;
  content?: string;
  summary?: string;
  /** Media RSS `media:description` (plain text; Atom/YouTube feeds). */
  mediaDescription?: string;
  /** Media RSS `media:thumbnail` URL, first one found. */
  mediaThumbnailUrl?: string;
  /**
   * Raw date strings in document order; the caller replays selection with
   * the JS date parsers (see `src/server/feed/streaming/`).
   */
  dateCandidates: DateCandidate[];
}

export interface RawParsedFeed {
  title?: string;
  description?: string;
  siteUrl?: string;
  iconUrl?: string;
  hubUrl?: string;
  selfUrl?: string;
  /** RSS `<ttl>` in minutes (already validated > 0). */
  ttlMinutes?: number;
  /** `sy:updatePeriod`, lowercased and validated. */
  updatePeriod?: string;
  /** `sy:updateFrequency` (already validated > 0). */
  updateFrequency?: number;
  entries: RawParsedEntry[];
}

export interface RawOpmlFeed {
  xmlUrl: string;
  title?: string;
  htmlUrl?: string;
  category?: string[];
}

export interface RawOpmlResult {
  feeds: RawOpmlFeed[];
  /** Whether an `<opml>` element was seen (validation stays in TS). */
  hasOpml: boolean;
  /** Whether a `<body>` element was seen (validation stays in TS). */
  hasBody: boolean;
}

/** Parses an RSS feed (RSS 2.0 or RSS 1.0/RDF). Synchronous. */
export function parseRss(content: string): RawParsedFeed;

/** Parses an Atom feed. Synchronous. */
export function parseAtom(content: string): RawParsedFeed;

/** Parses an OPML file. Synchronous. */
export function parseOpml(content: string): RawOpmlResult;

/**
 * Async form of `parseRss`: runs on the libuv thread pool so large feeds
 * never block the event loop.
 */
export function parseRssAsync(content: string): Promise<RawParsedFeed>;

/**
 * Async form of `parseAtom`: runs on the libuv thread pool so large feeds
 * never block the event loop.
 */
export function parseAtomAsync(content: string): Promise<RawParsedFeed>;

/**
 * Async form of `parseOpml`: runs on the libuv thread pool so large OPML
 * files never block the event loop.
 */
export function parseOpmlAsync(content: string): Promise<RawOpmlResult>;

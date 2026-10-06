/**
 * The identity of the benchmark dataset, shared by the seed (`seed.ts`) and the
 * benchmarks (`benchmarks.ts`): fixed ids for the rows a benchmark targets, the
 * reference instant every seeded timestamp hangs off, and the text vocabulary.
 * Everything here is deterministic, so two seeds produce the same rows.
 */

import { createHash } from "node:crypto";

/** "Now" for the seeded data: the date production's row counts were taken. */
export const ANCHOR = "2026-10-05T12:00:00Z";

/** A stable UUID for a seed label (md5, formatted as a UUID). */
export function benchUuid(label: string): string {
  const h = createHash("md5").update(`lion-bench:${label}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Seeded PRNG (mulberry32): the seed's plan is the same on every run. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Users, by index: 0 is the target user, 0–4 the heavy libraries. */
export const userId = (idx: number): string => benchUuid(`user:${idx}`);
export const userEmail = (idx: number): string => `bench-u${idx}@example.com`;

/** The benchmarks' target user (~130k entries, almost all unread). */
export const U0 = userId(0);

/**
 * Web feeds with a fixed role, by index into the web-feed list. The rest
 * (`FIRST_POOL_FEED` onwards) are assigned to subscribers at random.
 */
export const WEB = {
  /** Subscribed by 20 users: the fan-out target. */
  popular: 0,
  /** U0's ~4,000-entry, all-unread feed: the mark-all-read target. */
  markAll: 1,
  /** U0's 3,000-entry feed with 40 unread: the unread-only list target. */
  mostlyRead: 2,
  /** U0's 8,000-entry feed: the unsubscribe target. */
  large: 3,
  /** U0's feed that redirects onto `mergeTarget`. */
  mergeSource: 4,
  /** Not subscribed by U0; its current entries republish `mergeSource`'s guids over http. */
  mergeTarget: 5,
  /** Not subscribed by U0; 500 entries in its current document: the subscribe target. */
  history: 6,
} as const;
export const FIRST_POOL_FEED = 7;

export const webFeedId = (idx: number): string => benchUuid(`feed:web:${idx}`);
export const webFeedUrl = (idx: number): string => `https://feed-${idx}.example.com/rss`;
export const subscriptionId = (userIdx: number, feedKey: string): string =>
  benchUuid(`sub:${userIdx}:${feedKey}`);
export const webSubscriptionId = (userIdx: number, feedIdx: number): string =>
  subscriptionId(userIdx, `web:${feedIdx}`);

/**
 * The seeded collections. `empty` has no members (the add-1,000 target).
 * `archive` holds 1,000 (the large-delete target), so the seed has 1,071
 * collection_entries to production's 71; it belongs to U1 because every
 * counter recompute scans its owner's members, and U0's should stay
 * production-sized.
 */
export const COLLECTIONS = {
  readingList: { userIdx: 0, key: "reading-list", title: "Reading list" },
  research: { userIdx: 0, key: "research", title: "Research" },
  empty: { userIdx: 0, key: "inbox-zero", title: "Inbox zero" },
  archive: { userIdx: 1, key: "archive", title: "Archive" },
  favorites: { userIdx: 1, key: "favorites", title: "Favorites" },
} as const;
export const collectionSubscriptionId = (userIdx: number, key: string): string =>
  subscriptionId(userIdx, `collection:${key}`);

export const savedFeedId = (userIdx: number): string => benchUuid(`feed:saved:${userIdx}`);
export const savedSubscriptionId = (userIdx: number): string => subscriptionId(userIdx, "saved");
export const tagId = (userIdx: number, n: number): string => benchUuid(`tag:${userIdx}:${n}`);
export const tagName = (n: number): string => `Tag ${String(n).padStart(2, "0")}`;

const SYLLABLES = [
  "ka", "lo", "mi", "ren", "tas", "vel", "dor", "pin", "sul", "bra",
  "gen", "fo", "lut", "mar", "nex", "ol", "pra", "qui", "ros", "tir",
  "un", "vas", "wen", "yor", "zel", "cam", "dri", "fel", "gor", "hal",
  "jin", "kev", "lam", "mon", "nor", "pel", "ram", "sev", "tor", "wil",
]; // prettier-ignore

/**
 * 5,000 made-up words, most frequent first. Seeded text draws word rank `r`
 * with probability ∝ r^(-2/3) (rank = 1 + ⌊5000·u³⌋), a Zipf-like spread, so
 * a word's rank sets how many entries contain it.
 */
export function vocabulary(): string[] {
  const pairs = SYLLABLES.flatMap((a) => SYLLABLES.map((b) => a + b));
  const words = new Set([...pairs, ...pairs.flatMap((ab) => SYLLABLES.map((c) => ab + c))]);
  const rand = prng(1846);
  return [...words]
    .map((w) => ({ w, k: rand() }))
    .sort((x, y) => x.k - y.k)
    .slice(0, 5000)
    .map(({ w }) => w);
}

/**
 * The full-text query the search benchmark runs: a common word AND a rarer
 * one, matching roughly 1% of entries (about 1,000 of U0's).
 */
export function searchQuery(): string {
  const vocab = vocabulary();
  return `${vocab[299]} ${vocab[1999]}`;
}

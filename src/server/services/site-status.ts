/**
 * Site Status Service — global announcement banner + maintenance mode.
 *
 * Both flags live in **Redis**, deliberately NOT Postgres: maintenance mode is
 * meant to be turned on *while the database is being migrated / locked*, so the
 * gate that reads it must not depend on the DB being available. Redis is already
 * used for caching/SSE and is shared by every process group (app, worker,
 * discord — see fly.toml), so a single write is visible everywhere.
 *
 * Everything here is **fail-safe**: if Redis is unconfigured/unavailable or a
 * read throws, maintenance falls back to the `MAINTENANCE_MODE` env var only
 * (default off) and the announcement falls back to null. A Redis outage must
 * never accidentally take the site down or surface a stale banner.
 *
 * Reads are cached in-process for a few seconds so the hot paths (the custom
 * server's poller, the worker's claim loop, the Discord handlers) never issue a
 * Redis round-trip per request/job/message.
 */

import { createHash } from "node:crypto";
import { getRedisClient } from "@/server/redis";
import { logger } from "@/lib/logger";

const MAINTENANCE_KEY = "lion-reader:site-status:maintenance";
const ANNOUNCEMENT_KEY = "lion-reader:site-status:announcement";

/** How long a read is cached in-process before it's refreshed from Redis. */
const CACHE_TTL_MS = 5_000;

export const ANNOUNCEMENT_LEVELS = ["info", "warning"] as const;
export type AnnouncementLevel = (typeof ANNOUNCEMENT_LEVELS)[number];

/** Stored maintenance flag. */
export interface MaintenanceState {
  enabled: boolean;
  /** Optional message shown on the maintenance page. */
  message: string;
}

/** Stored announcement flag (as configured by the admin). */
export interface AnnouncementState {
  enabled: boolean;
  message: string;
  level: AnnouncementLevel;
}

/** Announcement as delivered to the banner, with a message-derived id. */
export interface Announcement {
  /**
   * Deterministic id derived from `message` + `level`. The banner stores the
   * dismissed id in a cookie, so the same text keeps the same id (a dismiss
   * sticks across no-op saves) while a changed message yields a new id and the
   * banner re-appears.
   */
  id: string;
  message: string;
  level: AnnouncementLevel;
}

const DEFAULT_MAINTENANCE: MaintenanceState = { enabled: false, message: "" };
const DEFAULT_ANNOUNCEMENT: AnnouncementState = { enabled: false, message: "", level: "info" };

/** `MAINTENANCE_MODE` env var as an always-on override (belt and suspenders). */
function envMaintenanceEnabled(): boolean {
  const raw = process.env.MAINTENANCE_MODE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function announcementId(message: string, level: AnnouncementLevel): string {
  return createHash("sha256").update(`${level}:${message}`).digest("hex").slice(0, 16);
}

// --- Tiny in-process TTL caches (one per key) -------------------------------

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

let maintenanceCache: CacheEntry<MaintenanceState> | null = null;
let announcementCache: CacheEntry<AnnouncementState> | null = null;

function invalidateCache(): void {
  maintenanceCache = null;
  announcementCache = null;
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const redis = getRedisClient();
  if (!redis) return fallback;
  try {
    const raw = await redis.get(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch (error) {
    logger.error("Failed to read site-status key from Redis", {
      key,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return fallback;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  const redis = getRedisClient();
  if (!redis) {
    logger.warn("Redis not configured; site-status change not persisted", { key });
    return;
  }
  await redis.set(key, JSON.stringify(value));
}

// --- Maintenance ------------------------------------------------------------

/** Reads the stored maintenance flag (uncached; includes disabled state). */
export async function getMaintenanceRaw(): Promise<MaintenanceState> {
  return readJson(MAINTENANCE_KEY, DEFAULT_MAINTENANCE);
}

/**
 * Effective maintenance state (env override OR Redis flag), cached in-process.
 * This is what the server gate / worker / bot consult.
 */
export async function getMaintenance(): Promise<MaintenanceState> {
  const now = Date.now();
  if (!maintenanceCache || maintenanceCache.expiresAt <= now) {
    const stored = await getMaintenanceRaw();
    const value: MaintenanceState = {
      enabled: stored.enabled || envMaintenanceEnabled(),
      message: stored.message,
    };
    maintenanceCache = { value, expiresAt: now + CACHE_TTL_MS };
  }
  return maintenanceCache.value;
}

export async function setMaintenance(input: { enabled: boolean; message?: string }): Promise<void> {
  await writeJson(MAINTENANCE_KEY, {
    enabled: input.enabled,
    message: input.message ?? "",
  } satisfies MaintenanceState);
  invalidateCache();
}

// --- Announcement -----------------------------------------------------------

/** Reads the stored announcement config (uncached; includes disabled state). */
export async function getAnnouncementRaw(): Promise<AnnouncementState> {
  const stored = await readJson(ANNOUNCEMENT_KEY, DEFAULT_ANNOUNCEMENT);
  // Guard against an unexpected level value from a hand-edited key.
  const level = ANNOUNCEMENT_LEVELS.includes(stored.level) ? stored.level : "info";
  return { ...stored, level };
}

/**
 * The active announcement to render, or null when disabled/empty. Cached
 * in-process (the root layout reads this on every SSR page render).
 */
export async function getAnnouncement(): Promise<Announcement | null> {
  const now = Date.now();
  if (!announcementCache || announcementCache.expiresAt <= now) {
    announcementCache = { value: await getAnnouncementRaw(), expiresAt: now + CACHE_TTL_MS };
  }
  const stored = announcementCache.value;
  if (!stored.enabled || stored.message.trim() === "") return null;
  return {
    id: announcementId(stored.message, stored.level),
    message: stored.message,
    level: stored.level,
  };
}

export async function setAnnouncement(input: {
  enabled: boolean;
  message: string;
  level: AnnouncementLevel;
}): Promise<void> {
  await writeJson(ANNOUNCEMENT_KEY, {
    enabled: input.enabled,
    message: input.message,
    level: input.level,
  } satisfies AnnouncementState);
  invalidateCache();
}

/** Test-only: clear the in-process caches so a fresh Redis read happens. */
export function __resetSiteStatusCacheForTests(): void {
  invalidateCache();
}

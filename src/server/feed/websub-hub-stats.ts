/**
 * Per-hub WebSub push-reliability tallying.
 *
 * A WebSub hub can silently stop pushing while we still believe it's active, so
 * a feed only refreshes on its 24h backup poll and new posts show up ~a day late.
 * We don't act on a single miss here, but we record, per hub, how new articles
 * first reached us so a chronically-broken hub (e.g. Google's
 * pubsubhubbub.appspot.com, which accepts pings but never pushes) becomes visible
 * in aggregate and can be dealt with later. See the `websubHubStats` table.
 *
 * All writes are best-effort: this is telemetry and must never break feed
 * processing, so failures are swallowed after logging.
 */

import { sql } from "drizzle-orm";
import { db as defaultDb } from "../db";
import { websubHubStats } from "../db/schema";
import { logger } from "@/lib/logger";

type DbClient = typeof defaultDb;

/**
 * Grace period for the backup-poll miss classification: 15 minutes.
 *
 * A new entry first found by a backup poll but published within this window may
 * simply not have been pushed *yet* (publish-time race), so we can't confidently
 * blame the hub. Such entries are counted as near-misses instead of misses.
 */
export const WEBSUB_PUSH_GRACE_PERIOD_MS = 15 * 60 * 1000;

/**
 * How a batch of backup-poll-discovered new entries splits between confirmed
 * push misses and ambiguous near-misses.
 */
export interface BackupPollClassification {
  /** New entries old enough that a working hub should have pushed them. */
  backupMisses: number;
  /** New entries too recent (or with an unknown publish date) to blame the hub. */
  nearMisses: number;
}

/**
 * Classifies backup-poll-discovered new entries into confirmed misses vs.
 * near-misses using the publish-time grace period. Pure so it can be unit-tested.
 *
 * An entry counts as a confirmed miss only when we know it was published at least
 * `gracePeriodMs` ago — long enough that a working hub should already have pushed
 * it. Entries published more recently, or with an unknown publish date (we can't
 * prove they're old), are counted as near-misses so they don't inflate the miss
 * count.
 */
export function classifyBackupPollEntries(
  publishedAts: Array<Date | null | undefined>,
  now: Date,
  gracePeriodMs: number = WEBSUB_PUSH_GRACE_PERIOD_MS
): BackupPollClassification {
  let backupMisses = 0;
  let nearMisses = 0;

  for (const publishedAt of publishedAts) {
    if (publishedAt && now.getTime() - publishedAt.getTime() >= gracePeriodMs) {
      backupMisses++;
    } else {
      nearMisses++;
    }
  }

  return { backupMisses, nearMisses };
}

/**
 * Upserts a per-hub tally, incrementing the given counters atomically.
 */
async function incrementHubStats(
  db: DbClient,
  hubUrl: string,
  delta: { byHub?: number; byBackup?: number; nearMiss?: number }
): Promise<void> {
  const byHub = delta.byHub ?? 0;
  const byBackup = delta.byBackup ?? 0;
  const nearMiss = delta.nearMiss ?? 0;

  try {
    await db
      .insert(websubHubStats)
      .values({
        hubUrl,
        articlesAnnouncedByHub: byHub,
        articlesAnnouncedByBackup: byBackup,
        articlesNearMiss: nearMiss,
      })
      .onConflictDoUpdate({
        target: websubHubStats.hubUrl,
        set: {
          articlesAnnouncedByHub: sql`${websubHubStats.articlesAnnouncedByHub} + ${byHub}`,
          articlesAnnouncedByBackup: sql`${websubHubStats.articlesAnnouncedByBackup} + ${byBackup}`,
          articlesNearMiss: sql`${websubHubStats.articlesNearMiss} + ${nearMiss}`,
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    // Telemetry must never break feed processing.
    logger.warn("Failed to update WebSub hub stats", {
      hubUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Records that `count` new entries reached us via a hub push notification.
 * No-op for a non-positive count.
 */
export async function recordHubAnnouncedEntries(
  hubUrl: string,
  count: number,
  db: DbClient = defaultDb
): Promise<void> {
  if (count <= 0) return;
  await incrementHubStats(db, hubUrl, { byHub: count });
}

/**
 * Records new entries first discovered by a backup poll on a feed we believed
 * push was covering — i.e. entries the hub failed to push. Splits them into
 * confirmed misses vs. near-misses via the publish-time grace period.
 */
export async function recordBackupPollNewEntries(
  hubUrl: string,
  publishedAts: Array<Date | null | undefined>,
  now: Date,
  db: DbClient = defaultDb
): Promise<void> {
  const { backupMisses, nearMisses } = classifyBackupPollEntries(publishedAts, now);
  if (backupMisses === 0 && nearMisses === 0) return;
  await incrementHubStats(db, hubUrl, { byBackup: backupMisses, nearMiss: nearMisses });
}

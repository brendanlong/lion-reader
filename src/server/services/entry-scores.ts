/**
 * Score writes (#2064): how much the user wants each article, which an AI
 * assistant sets to prioritize their reading. Higher sorts first; a null
 * score clears it. The score is the user's state, like read and starred: it
 * lives on `user_entries`, whose triggers copy it to the article's list rows.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { userEntries } from "@/server/db/schema";
import { errors } from "@/server/errors";
import { visibleUserEntrySql } from "./entry-filters";
import { lockUserEntryRows, publishEntryStates } from "./entry-state";

/** The most scores one write may set. */
export const MAX_ENTRY_SCORE_BATCH = 1000;

export interface EntryScore {
  entryId: string;
  /** Any finite number, or null to clear it. */
  score: number | null;
}

export interface SetEntryScoresResult {
  /** Entries whose score changed, with their new score. */
  changed: EntryScore[];
  /** Requested entries the user can't see (or that don't exist); nothing was set for them. */
  notFoundIds: string[];
}

/**
 * Sets or clears the scores of the user's visible entries. An entry named
 * twice takes its last score. Only a real change moves the row's
 * `updated_at`, so delta sync re-delivers just those ("Row Written vs. Value
 * Flipped" in `src/server/CLAUDE.md`).
 */
export async function setEntryScores(
  db: typeof dbType,
  userId: string,
  scores: EntryScore[]
): Promise<SetEntryScoresResult> {
  if (scores.length > MAX_ENTRY_SCORE_BATCH) {
    throw errors.validation(`Maximum ${MAX_ENTRY_SCORE_BATCH} scores per request`);
  }
  if (scores.some(({ score }) => score !== null && !Number.isFinite(score))) {
    throw errors.validation("A score must be a finite number or null");
  }
  const byEntry = new Map(scores.map(({ entryId, score }) => [entryId, score]));
  if (byEntry.size === 0) return { changed: [], notFoundIds: [] };

  const values = [...byEntry].map(
    ([entryId, score]) => sql`(${entryId}::uuid, ${score}::double precision)`
  );
  const visible = await db
    .select({ entryId: userEntries.entryId })
    .from(userEntries)
    .where(
      and(
        eq(userEntries.userId, userId),
        inArray(userEntries.entryId, [...byEntry.keys()]),
        visibleUserEntrySql()
      )
    );
  const updated = await db.transaction(async (tx) => {
    await lockUserEntryRows(tx, userId, [...byEntry.keys()]);
    return tx.execute<{ entry_id: string; score: number | null }>(sql`
    UPDATE ${userEntries}
    SET score = v.score, updated_at = ${new Date()}
    FROM (VALUES ${sql.join(values, sql`, `)}) AS v(entry_id, score)
    WHERE ${userEntries.userId} = ${userId}::uuid
      AND ${userEntries.entryId} = v.entry_id
      AND ${visibleUserEntrySql()}
      AND ${userEntries.score} IS DISTINCT FROM v.score
    RETURNING ${userEntries.entryId}, ${userEntries.score}
  `);
  });

  const found = new Set(visible.map((row) => row.entryId));
  publishEntryStates(
    db,
    userId,
    updated.rows.map((row) => row.entry_id)
  );
  return {
    changed: updated.rows.map((row) => ({ entryId: row.entry_id, score: row.score })),
    notFoundIds: [...byEntry.keys()].filter((id) => !found.has(id)),
  };
}

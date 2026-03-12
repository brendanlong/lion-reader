/**
 * Temporal.Instant utilities for microsecond-precision timestamps.
 *
 * Provides a Drizzle `customType` that maps Postgres `timestamptz` to
 * `Temporal.Instant`, preserving microsecond precision that JavaScript's
 * `Date` loses (Date only supports milliseconds).
 *
 * Also provides a SQL helper `microsecondISO()` for extracting
 * microsecond-precision ISO 8601 strings from timestamp columns without
 * the verbose `to_char(... AT TIME ZONE 'UTC', '...')` boilerplate.
 *
 * @see https://github.com/brendanlong/lion-reader/issues/683
 * @see https://github.com/brendanlong/lion-reader/issues/680
 */

import { Temporal } from "temporal-polyfill";
import { customType } from "drizzle-orm/pg-core";
import { sql, type SQL, type AnyColumn } from "drizzle-orm";

/**
 * Drizzle custom column type mapping Postgres `timestamptz` to `Temporal.Instant`.
 *
 * Preserves microsecond precision by receiving raw strings from node-postgres
 * (requires `pg.types.setTypeParser(1184, val => val)` in db/index.ts)
 * and converting them to `Temporal.Instant`.
 *
 * Usage in schema:
 * ```typescript
 * export const myTable = pgTable("my_table", {
 *   createdAt: temporalTimestamp("created_at").notNull().defaultNow(),
 * });
 * ```
 *
 * Note: Currently not used for existing schema columns to avoid cascading
 * type changes (Date → Temporal.Instant) across the entire codebase.
 * Available for new columns or future migration.
 */
export const temporalTimestamp = customType<{
  data: Temporal.Instant;
  dpiData: string;
}>({
  dataType() {
    return "timestamptz";
  },
  fromDriver(value: unknown): Temporal.Instant {
    // With pg type parser returning raw strings, value is like:
    // "2024-01-15 12:34:56.123456+00"
    // Convert to ISO 8601 format for Temporal.Instant.from()
    const str = String(value);
    const iso = str.replace(" ", "T").replace(/\+00$/, "+00:00");
    return Temporal.Instant.from(iso);
  },
  toDriver(value: Temporal.Instant): string {
    // Temporal.Instant.toString() returns full-precision ISO 8601
    // e.g., "2024-01-15T12:34:56.123456Z"
    return value.toString();
  },
});

/**
 * SQL helper to extract a microsecond-precision ISO 8601 string from a
 * timestamp column or expression.
 *
 * Replaces the verbose pattern:
 * ```sql
 * to_char(column AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
 * ```
 *
 * With:
 * ```typescript
 * microsecondISO(column)
 * ```
 *
 * @param column - A Drizzle column reference or SQL expression
 * @returns SQL expression that evaluates to an ISO 8601 string with microsecond precision
 */
export function microsecondISO(column: AnyColumn | SQL): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * Compare two ISO 8601 timestamp strings with microsecond precision.
 *
 * Uses `Temporal.Instant.compare()` instead of `new Date()` to avoid
 * precision loss when comparing timestamps. JavaScript's `Date` truncates
 * to milliseconds, which can cause cursor comparison bugs (#680).
 *
 * @returns negative if a < b, 0 if equal, positive if a > b
 */
export function compareTimestamps(a: string, b: string): number {
  return Temporal.Instant.compare(Temporal.Instant.from(a), Temporal.Instant.from(b));
}

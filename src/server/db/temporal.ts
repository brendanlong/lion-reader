import { customType } from "drizzle-orm/pg-core";
import { types as pgTypes, type CustomTypesConfig } from "pg";
import { Temporal } from "temporal-polyfill";

/**
 * Full-precision timestamp handling for Postgres `timestamptz`.
 *
 * node-postgres parses `timestamptz` (OID 1184) into a JavaScript `Date` by
 * default, and a `Date` truncates to millisecond precision — silently dropping
 * the microseconds Postgres stores. That truncation corrupted keyset cursors
 * built from timestamps: a cursor read back as a `Date` would land in the gap
 * between two rows sharing a millisecond, dropping or re-delivering entries
 * (#680, #683).
 *
 * The app pool (`src/server/db/index.ts`) overrides the OID 1184 parser to hand
 * back Postgres's raw string instead of a `Date`, so a `timestamptz` read keeps
 * full precision. Drizzle's built-in `timestamp` columns still map that string to
 * a `Date` (unchanged behaviour, still millisecond precision). The helpers below
 * decode the same raw string to a `Temporal.Instant`, which preserves microseconds
 * and — via `toString()` — round-trips to ISO-8601 without a `to_char` expression.
 */

// node-postgres OID for `timestamp with time zone`.
const TIMESTAMPTZ_OID = 1184;

/**
 * A node-postgres `types` config that returns the raw Postgres string for
 * `timestamptz` (OID 1184) instead of parsing it into a truncating `Date`.
 *
 * **Every Drizzle pool that might read a `temporalTimestamp` column (or decode a
 * timestamp via {@link parseTimestamptz}) MUST use this config**, or `fromDriver`
 * receives a `Date`, `String(date)` yields a non-ISO string, and
 * `Temporal.Instant.from` throws. The app pool (`src/server/db/index.ts`) and the
 * test/seed pools (`tests/e2e/helpers.ts`, `scripts/seed.ts`) all install it.
 * Text format only: binary result mode (unused here) keeps the default parser.
 */
export const timestamptzRawParserConfig: CustomTypesConfig = {
  getTypeParser: (oid, format) =>
    oid === TIMESTAMPTZ_OID && format !== "binary"
      ? (value: string) => value
      : pgTypes.getTypeParser(oid, format),
};

/**
 * Parse a Postgres `timestamptz` driver value into a `Temporal.Instant`.
 *
 * `Temporal.Instant.from` accepts both Postgres's space-separated
 * `2026-07-14 05:34:56.789012-07` form (what the OID 1184 parser override yields)
 * and ISO-8601 `2026-07-14T12:34:56.789012Z`, normalising either to a UTC instant.
 */
export function parseTimestamptz(value: unknown): Temporal.Instant {
  return Temporal.Instant.from(String(value));
}

/**
 * Null-tolerant {@link parseTimestamptz}, for nullable expressions such as
 * `MAX(...)`/`GREATEST(...)` aggregates over an empty set.
 */
export function parseTimestamptzOrNull(value: unknown): Temporal.Instant | null {
  return value == null ? null : parseTimestamptz(value);
}

/**
 * Drizzle column type mapping Postgres `timestamptz` to a full-precision
 * `Temporal.Instant` on read and an ISO-8601 string on write. Use for columns
 * read as cursor sort keys, where the millisecond truncation of a `Date` would
 * corrupt keyset pagination.
 */
export const temporalTimestamp = customType<{ data: Temporal.Instant; driverData: string }>({
  dataType() {
    return "timestamptz";
  },
  fromDriver(value) {
    return parseTimestamptz(value);
  },
  toDriver(value) {
    return value.toString();
  },
});

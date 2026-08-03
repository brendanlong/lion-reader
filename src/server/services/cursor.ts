/**
 * Shared keyset-pagination cursor codec.
 *
 * A cursor is the sort key of the last row on a page — a small tuple whose
 * shape depends on the ordering — serialized as JSON and base64url-encoded.
 * Each paginated query declares its tuple as a Zod schema and gets a typed
 * `encode`/`decode` pair, so the envelope (and its two subtleties below) lives
 * in exactly one place.
 *
 * See "Ordering & Pagination Mechanics" in `src/server/CLAUDE.md`.
 */

import { z } from "zod";
import { isValidUuid } from "@/lib/uuidv7";
import { errors } from "@/server/trpc/errors";

/**
 * A row id inside a cursor. Callers interpolate it into a uuid comparison, so a
 * non-UUID would reach Postgres as "invalid input syntax for type uuid" and 500
 * (Sentry noise) — reject it while decoding instead.
 */
export const cursorUuid = z.string().refine(isValidUuid);

export interface CursorCodec<T> {
  encode(value: T): string;
  decode(cursor: string): T;
}

/**
 * Builds a cursor codec for one keyset tuple shape.
 *
 * @param schema - Zod schema for the tuple; decoding rejects anything it fails
 * @returns Typed `encode`/`decode` for that shape
 */
export function createCursorCodec<Schema extends z.ZodType>(
  schema: Schema
): CursorCodec<z.output<Schema>> {
  return {
    encode(value) {
      // base64url (no "+", "/", or "=" padding) so the cursor is safe to place in
      // a URL query string. It is surfaced as the Google Reader `continuation`
      // token, and some clients (e.g. Read You) concatenate query params without
      // URL-encoding — a "+" in standard base64 would decode to a space
      // server-side and corrupt the cursor, 400ing every page past the first and
      // aborting sync.
      return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    },
    decode(cursor) {
      let parsed: unknown;
      try {
        // Node's "base64" decoder accepts both the standard (+/=) and URL-safe
        // (-_) alphabets, so this still decodes cursors emitted before the
        // switch to base64url, as well as any a client mangled by not
        // URL-encoding the standard form (e.g. "+" arriving as a space).
        parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
      } catch {
        throw errors.validation("Invalid cursor format");
      }
      const result = schema.safeParse(parsed);
      if (!result.success) {
        throw errors.validation("Invalid cursor format");
      }
      return result.data as z.output<Schema>;
    },
  };
}

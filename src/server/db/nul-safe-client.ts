import { Client, type ClientConfig } from "pg";

import { replaceNul } from "./nul";

function replaceNulInValues(values: unknown): unknown {
  return Array.isArray(values)
    ? values.map((value: unknown) => (typeof value === "string" ? replaceNul(value) : value))
    : values;
}

/** Normalizes `client.query(text | config, values?, callback?)` arguments. */
function replaceNulInQueryArgs(args: unknown[]): unknown[] {
  const [first, values, ...rest] = args;
  const config =
    // A Submittable (pg-cursor, pg-query-stream) can't be copied; drizzle
    // always passes a plain config.
    first !== null && typeof first === "object" && "values" in first && !("submit" in first)
      ? { ...first, values: replaceNulInValues(first.values) }
      : first;
  return [config, replaceNulInValues(values), ...rest];
}

/**
 * Replaces NUL in string query params (see `replaceNul`). Drizzle serializes
 * array params to `{...}` strings, so only top-level strings need checking.
 * `jsonb` values arrive already JSON-escaped: columns written through Drizzle
 * are handled by `nulSafeJsonb`, raw `JSON.stringify(...)::jsonb` params aren't.
 */
export class NulSafeClient extends Client {
  constructor(config?: string | ClientConfig) {
    super(config);
    const query = this.query.bind(this) as (...args: unknown[]) => unknown;
    this.query = ((...args: unknown[]) =>
      query(...replaceNulInQueryArgs(args))) as unknown as Client["query"];
  }
}

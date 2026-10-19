import { Client, type ClientConfig } from "pg";

/**
 * Postgres `text` can't hold U+0000 ("invalid byte sequence for encoding
 * UTF8: 0x00"), yet it reaches us from untrusted content: HTML allows it as a
 * recoverable parse error (TanStack Router pages put it in inline scripts),
 * and `JSON.parse` turns `"\u0000"` escapes into it. We replace it here, at
 * the one boundary every source passes through, with U+FFFD — what browsers
 * substitute for it in scripts and attributes.
 *
 * Array and JSON params arrive already serialized to strings (drizzle builds
 * `{...}` literals), so only top-level strings need checking. A `\u0000`
 * *escape* in a `jsonb` value is untouched (and still rejected).
 */
const NUL = "\u0000";
const REPLACEMENT_CHARACTER = "\uFFFD";

function replaceNul(value: unknown): unknown {
  return typeof value === "string" && value.includes(NUL)
    ? value.replaceAll(NUL, REPLACEMENT_CHARACTER)
    : value;
}

function replaceNulInValues(values: unknown): unknown {
  return Array.isArray(values) ? values.map(replaceNul) : values;
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

export class NulSafeClient extends Client {
  constructor(config?: string | ClientConfig) {
    super(config);
    const query = this.query.bind(this) as (...args: unknown[]) => unknown;
    this.query = ((...args: unknown[]) =>
      query(...replaceNulInQueryArgs(args))) as unknown as Client["query"];
  }
}

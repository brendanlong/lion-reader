/**
 * Postgres `text` and `jsonb` can't hold U+0000 ("invalid byte sequence for
 * encoding UTF8: 0x00"), yet it reaches us from untrusted content: HTML allows
 * it as a recoverable parse error (TanStack Router pages put it in inline
 * scripts), and `JSON.parse` decodes the escape into it. We replace it with
 * U+FFFD — what browsers substitute for it in scripts and attributes — in
 * query params (`NulSafeClient`) and `jsonb` values (`nulSafeJsonb`).
 *
 * Also apply it to a value compared in JS against one read back from the
 * database, so both sides match (e.g. feed guids).
 */
export function replaceNul(value: string): string {
  return value.includes("\u0000") ? value.replaceAll("\u0000", "�") : value;
}

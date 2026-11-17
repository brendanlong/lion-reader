/**
 * A `Retry-After` header in whole seconds from `now`: a number of them, or an
 * HTTP date. Null when absent or unparseable; a time already past is 0.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}

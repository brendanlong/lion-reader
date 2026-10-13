/**
 * Pure email parsing utilities.
 *
 * This module contains pure functions for parsing email addresses and headers
 * that don't require database access. Extracted to allow unit testing without
 * database imports.
 */

/**
 * Strips surrounding double quotes and unescapes an email display name.
 * RFC 2822 uses quotes for names containing special characters like & or commas,
 * and backslash escaping for literal quotes and backslashes within the name.
 *
 * @param name - The raw display name from an email header
 * @returns The name with surrounding quotes removed and escape sequences resolved
 */
export function stripEmailNameQuotes(name: string): string {
  // RFC 2822 quoted-string: names with special chars are wrapped in double quotes
  if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
    const unquoted = name.slice(1, -1);
    // Unescape RFC 2822 quoted-pair: \" -> " and \\ -> \
    return unquoted.replace(/\\(.)/g, "$1");
  }
  return name;
}

/**
 * Parses a "From" address string into email and name components.
 * Handles formats:
 * - "Name <email@example.com>"
 * - '"Quoted Name" <email@example.com>' (RFC 2822 quoted names)
 * - "<email@example.com>"
 * - "email@example.com"
 *
 * @param from - The from string to parse
 * @returns Object with address and optional name
 */
export function parseFromAddress(from: string): { address: string; name?: string } {
  // "Name <email>": the address runs from a "<" to the closing ">" and can't
  // contain ">", so it opens at the first "<" after the last inner ">" that
  // leaves a non-empty name. Found by index, not `^(.+?)\s*<([^>]+)>$`, which
  // retries the address scan at every "<" and is quadratic on a hostile header.
  if (from.endsWith(">")) {
    const lastInnerClose = from.lastIndexOf(">", from.length - 2);
    const open = from.indexOf("<", Math.max(lastInnerClose + 1, 1));
    if (open > 0 && open < from.length - 2) {
      // Strip surrounding quotes from the name (RFC 2822 quoted-string)
      const name = stripEmailNameQuotes(from.slice(0, open).trim());
      return {
        address: from.slice(open + 1, -1).trim(),
        name: name || undefined,
      };
    }
  }

  // Try to match "<email>" format
  const matchAngleBrackets = from.match(/^<([^>]+)>$/);
  if (matchAngleBrackets) {
    return {
      address: matchAngleBrackets[1].trim(),
    };
  }

  // Assume it's just an email address
  return {
    address: from.trim(),
  };
}

/**
 * The URL of each scheme in a List-Unsubscribe header. `[^<>]+`, not `[^>]+`:
 * with `[^>]+`, a header of repeated `<mailto:` and no `>` makes every match
 * attempt scan to the end — quadratic.
 */
const LIST_UNSUBSCRIBE_URL_PATTERNS = {
  mailto: /<(mailto:[^<>]+)>/i,
  https: /<(https:[^<>]+)>/i,
} as const;

/**
 * Extracts the first URL of the given scheme from a List-Unsubscribe header,
 * which lists URLs in angle brackets, comma-separated:
 * "<mailto:unsub@example.com>, <https://example.com/unsub>"
 */
export function parseListUnsubscribeUrl(
  header: string | undefined,
  scheme: keyof typeof LIST_UNSUBSCRIBE_URL_PATTERNS
): string | null {
  if (!header) return null;
  return LIST_UNSUBSCRIBE_URL_PATTERNS[scheme].exec(header)?.[1] ?? null;
}

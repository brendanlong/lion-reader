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
  // Try to match "Name <email>" format
  const matchWithName = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (matchWithName) {
    const rawName = matchWithName[1].trim();
    const address = matchWithName[2].trim();
    // Strip surrounding quotes from the name (RFC 2822 quoted-string)
    const name = stripEmailNameQuotes(rawName);
    return {
      address,
      name: name || undefined,
    };
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

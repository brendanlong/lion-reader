/**
 * HTTP Link header parser for WebSub discovery.
 *
 * Parses RFC 5988 / RFC 8288 Link headers to extract hub and self URLs
 * for WebSub (PubSubHubbub) discovery.
 *
 * @see https://www.w3.org/TR/websub/#discovery
 * @see https://datatracker.ietf.org/doc/html/rfc8288
 */

/**
 * Result of parsing Link headers for WebSub-relevant links.
 */
export interface WebSubLinkHeaders {
  /** WebSub hub URL from Link header with rel="hub" */
  hubUrl?: string;
  /** Self/topic URL from Link header with rel="self" */
  selfUrl?: string;
}

/**
 * Parses HTTP Link headers to extract WebSub hub and self URLs.
 *
 * Handles multiple Link headers (comma-separated or multiple header values)
 * per RFC 8288. Each link value has the format:
 *   <url>; param1=value1; param2=value2
 *
 * We extract links where rel="hub" or rel="self".
 *
 * @param linkHeader - The raw Link header value (may contain multiple comma-separated links)
 * @returns Extracted hub and self URLs, if found
 *
 * @example
 * parseWebSubLinkHeaders('<https://hub.example.com/>; rel="hub", <https://example.com/feed>; rel="self"')
 * // => { hubUrl: "https://hub.example.com/", selfUrl: "https://example.com/feed" }
 */
export function parseWebSubLinkHeaders(linkHeader: string): WebSubLinkHeaders {
  const result: WebSubLinkHeaders = {};

  // Split on commas that are outside angle brackets to separate individual links.
  // A Link header can contain multiple links: <url1>; rel="hub", <url2>; rel="self"
  // We need to be careful not to split on commas inside the URL itself.
  const links = splitLinkHeader(linkHeader);

  for (const link of links) {
    const trimmed = link.trim();
    if (!trimmed) continue;

    // Extract the URL from <...>
    const urlMatch = trimmed.match(/^<([^>]*)>/);
    if (!urlMatch) continue;

    const url = urlMatch[1];

    // Extract the rel parameter value
    // Handles both quoted and unquoted values: rel="hub" or rel=hub
    const relMatch = trimmed.match(/;\s*rel\s*=\s*"?([^";,\s]+)"?/i);
    if (!relMatch) continue;

    const rel = relMatch[1].toLowerCase();

    if (rel === "hub" && url) {
      result.hubUrl = url;
    } else if (rel === "self" && url) {
      result.selfUrl = url;
    }
  }

  return result;
}

/**
 * Splits a Link header value into individual link entries.
 *
 * Handles commas that separate links while avoiding splitting on commas
 * that appear inside angle-bracketed URLs.
 *
 * @param header - The raw Link header value
 * @returns Array of individual link strings
 */
function splitLinkHeader(header: string): string[] {
  const links: string[] = [];
  let current = "";
  let insideAngleBrackets = false;

  for (const char of header) {
    if (char === "<") {
      insideAngleBrackets = true;
      current += char;
    } else if (char === ">") {
      insideAngleBrackets = false;
      current += char;
    } else if (char === "," && !insideAngleBrackets) {
      links.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    links.push(current);
  }

  return links;
}

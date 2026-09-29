/**
 * Decodes fetched bytes to text, honoring the declared character encoding
 * (issue #1546).
 *
 * Precedence follows the HTML encoding-sniffing algorithm and RFC 7303 (XML):
 * a byte-order mark wins, then the `charset` on `Content-Type`, then the
 * document's own declaration (`<?xml … encoding="…"?>`, or `<meta charset>` /
 * `<meta http-equiv="Content-Type">` for HTML), then UTF-8. Labels are resolved
 * by `TextDecoder`, i.e. the WHATWG Encoding Standard, so `latin1` and
 * `iso-8859-1` mean windows-1252 exactly as they do in a browser; an unknown
 * label falls through to the next source.
 */

/** How far into the body to look for an in-document declaration (the HTML prescan limit). */
const DECLARATION_PRESCAN_BYTES = 1024;

const XML_DECLARATION_ENCODING = /^\s*<\?xml\s[^>]*?\bencoding\s*=\s*["']([^"']+)["']/;
const META_CHARSET = /<meta\s[^>]*?\bcharset\s*=\s*["']?\s*([^"'\s;/>]+)/i;
const CONTENT_TYPE_CHARSET = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i;

function resolveEncoding(label: string): string | null {
  try {
    return new TextDecoder(label.trim()).encoding;
  } catch {
    return null;
  }
}

function encodingFromBom(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  return null;
}

function encodingFromContentType(contentType: string): string | null {
  const match = CONTENT_TYPE_CHARSET.exec(contentType);
  const label = match?.[1] ?? match?.[2];
  return label ? resolveEncoding(label) : null;
}

/**
 * The encoding a document declares about itself, read from an ASCII view of its
 * first bytes. A declaration we could read that way can't really be UTF-16, so
 * (as the HTML spec prescribes for `<meta>`) a UTF-16 label means UTF-8.
 */
function encodingFromDeclaration(bytes: Uint8Array, contentType: string): string | null {
  const head = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    Math.min(bytes.byteLength, DECLARATION_PRESCAN_BYTES)
  ).toString("latin1");

  // Only look for <meta> in something that may be HTML: a JSON, Markdown or
  // plain-text body can mention `<meta charset=…>` without meaning it.
  const mimeType = contentType.split(";")[0].trim().toLowerCase();
  const mayBeHtml = mimeType === "" || mimeType.includes("html");

  const label =
    XML_DECLARATION_ENCODING.exec(head)?.[1] ?? (mayBeHtml ? META_CHARSET.exec(head)?.[1] : null);
  const encoding = label ? resolveEncoding(label) : null;
  return encoding?.startsWith("utf-16") ? "utf-8" : encoding;
}

/**
 * Decodes a fetched body to a string using its declared encoding.
 *
 * @param bytes - The raw body
 * @param contentType - The `Content-Type` header value, or null if absent
 */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const type = contentType ?? "";
  const encoding =
    encodingFromBom(bytes) ??
    encodingFromContentType(type) ??
    encodingFromDeclaration(bytes, type) ??
    "utf-8";
  // TextDecoder strips a BOM matching the encoding it decodes with.
  return new TextDecoder(encoding).decode(bytes);
}

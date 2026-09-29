/**
 * Unit tests for decoding fetched bodies in their declared charset (#1546).
 */

import { describe, it, expect } from "vitest";
import { decodeBody } from "../../src/server/http/charset";

/** Builds bytes from ASCII text plus raw byte values (for non-UTF-8 content). */
function bytes(...parts: Array<string | number[]>): Buffer {
  return Buffer.concat(
    parts.map((part) =>
      typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part)
    )
  );
}

// “café” in windows-1252: 0x93 c a f 0xE9 0x94
const CP1252_QUOTED_CAFE = [0x93, 0x63, 0x61, 0x66, 0xe9, 0x94];

describe("decodeBody", () => {
  it("defaults to UTF-8", () => {
    expect(decodeBody(Buffer.from("“café”"), null)).toBe("“café”");
    expect(decodeBody(Buffer.from("“café”"), "text/html")).toBe("“café”");
  });

  it("uses the Content-Type charset", () => {
    expect(decodeBody(bytes(CP1252_QUOTED_CAFE), "text/html; charset=windows-1252")).toBe("“café”");
  });

  it("accepts a quoted, differently-cased charset parameter", () => {
    expect(decodeBody(bytes(CP1252_QUOTED_CAFE), 'text/plain; Charset="Windows-1252"')).toBe(
      "“café”"
    );
  });

  it("maps iso-8859-1 to windows-1252 like browsers do", () => {
    expect(decodeBody(bytes(CP1252_QUOTED_CAFE), "text/html; charset=iso-8859-1")).toBe("“café”");
  });

  it("reads the XML declaration when the header has no charset", () => {
    const body = bytes('<?xml version="1.0" encoding="ISO-8859-1"?><title>', CP1252_QUOTED_CAFE);
    expect(decodeBody(body, "text/xml")).toBe(
      '<?xml version="1.0" encoding="ISO-8859-1"?><title>“café”'
    );
  });

  it("reads the XML declaration with single quotes and no content type", () => {
    const body = bytes("<?xml version='1.0' encoding='windows-1252'?><t>", CP1252_QUOTED_CAFE);
    expect(decodeBody(body, null)).toContain("“café”");
  });

  it("reads <meta charset> in HTML", () => {
    const body = bytes('<html><head><meta charset="windows-1252"></head><p>', CP1252_QUOTED_CAFE);
    expect(decodeBody(body, "text/html")).toContain("<p>“café”");
  });

  it("reads <meta http-equiv> content-type in HTML", () => {
    const body = bytes(
      '<html><head><META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=iso-8859-1"></head><p>',
      CP1252_QUOTED_CAFE
    );
    expect(decodeBody(body, "text/html")).toContain("<p>“café”");
  });

  it("prefers the Content-Type charset over an in-document declaration", () => {
    const body = Buffer.from('<meta charset="windows-1252"><p>“café”');
    expect(decodeBody(body, "text/html; charset=utf-8")).toContain("<p>“café”");
  });

  it("prefers a BOM over the Content-Type charset, and strips it", () => {
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("“café”")]);
    expect(decodeBody(body, "text/html; charset=windows-1252")).toBe("“café”");
  });

  it("decodes UTF-16 with a BOM", () => {
    const body = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("“café”", "utf16le")]);
    expect(decodeBody(body, "text/xml")).toBe("“café”");
  });

  it("treats a UTF-16 label in an ASCII-readable declaration as UTF-8", () => {
    const body = Buffer.from('<?xml version="1.0" encoding="UTF-16"?><t>“café”</t>');
    expect(decodeBody(body, "application/xml")).toContain("<t>“café”</t>");
  });

  it("falls back to UTF-8 on an unknown label", () => {
    expect(decodeBody(Buffer.from("“café”"), "text/html; charset=no-such-charset")).toBe("“café”");
    const body = Buffer.from('<meta charset="bogus"><p>“café”');
    expect(decodeBody(body, "text/html")).toContain("<p>“café”");
  });

  it("ignores a <meta charset> mentioned in a non-HTML body", () => {
    const body = Buffer.from('{"html":"<meta charset=\\"windows-1252\\">","text":"“café”"}');
    expect(decodeBody(body, "application/json")).toContain("“café”");
  });

  it("only honors a <meta> within the first 1024 bytes", () => {
    const body = Buffer.from(`${" ".repeat(1024)}<meta charset="windows-1252"><p>“café”`);
    expect(decodeBody(body, "text/html")).toContain("<p>“café”");
  });
});

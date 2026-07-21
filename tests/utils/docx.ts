/**
 * Minimal in-memory `.docx` / ZIP builders for tests.
 *
 * A `.docx` is just an OPC (Open Packaging Conventions) ZIP. These helpers build
 * a valid-enough archive from a set of parts so tests can exercise the docx
 * upload path (mammoth conversion + `docProps/core.xml` extraction) without
 * shipping a binary fixture.
 */

import { deflateRawSync } from "node:zlib";

interface ZipEntry {
  name: string;
  data: Buffer;
}

// Standard CRC-32 (IEEE 802.3), needed for a well-formed ZIP.
function crc32(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

/**
 * Build a ZIP archive from the given files. Entries are deflate-compressed by
 * default; pass `compression: "store"` to write them uncompressed (method 0),
 * which exercises the reader's stored branch.
 */
export function buildZip(
  files: Record<string, string>,
  options: { compression?: "deflate" | "store" } = {}
): Buffer {
  const store = options.compression === "store";
  const method = store ? 0 : 8;
  const entries: ZipEntry[] = Object.entries(files).map(([name, content]) => ({
    name,
    data: Buffer.from(content, "utf8"),
  }));

  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const compressed = store ? entry.data : deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8); // compression method
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    localChunks.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central dir signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(method, 10); // compression method
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0, 14); // mod date
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralChunks);
  const localSection = Buffer.concat(localChunks);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central dir size
  eocd.writeUInt32LE(localSection.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localSection, centralDir, eocd]);
}

/** Build a `docProps/core.xml` document from optional core properties. */
export function buildCoreXml(props: {
  title?: string;
  creator?: string;
  description?: string;
}): string {
  const parts: string[] = [];
  if (props.title !== undefined) parts.push(`<dc:title>${props.title}</dc:title>`);
  if (props.creator !== undefined) parts.push(`<dc:creator>${props.creator}</dc:creator>`);
  if (props.description !== undefined)
    parts.push(`<dc:description>${props.description}</dc:description>`);
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:dcterms="http://purl.org/dc/terms/">' +
    parts.join("") +
    "</cp:coreProperties>"
  );
}

/**
 * Build a minimal but valid `.docx` buffer: one or more body paragraphs plus an
 * optional `docProps/core.xml`. Parseable by mammoth.
 */
export function buildMinimalDocx(options: {
  paragraphs: string[];
  core?: { title?: string; creator?: string; description?: string };
}): Buffer {
  const bodyParagraphs = options.paragraphs
    .map((text) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`)
    .join("");

  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${bodyParagraphs}</w:body></w:document>`;

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    "</Types>";

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    "</Relationships>";

  const files: Record<string, string> = {
    "[Content_Types].xml": contentTypes,
    "_rels/.rels": rels,
    "word/document.xml": document,
  };

  if (options.core) {
    files["docProps/core.xml"] = buildCoreXml(options.core);
  }

  return buildZip(files);
}

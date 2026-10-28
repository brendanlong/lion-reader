/**
 * Minimal in-memory `.epub` builder for tests: a container, a package document
 * listing the given spine, and optionally an EPUB 3 nav or an EPUB 2 NCX.
 */

import { buildZip } from "./docx";

export interface EpubSpineItem {
  path: string;
  xhtml: string;
  linear?: boolean;
}

export interface EpubTocEntry {
  href: string;
  label: string;
  /** 1 (the default) for a top-level entry. */
  depth?: number;
}

/** A nav's nested `<ol>`s, each entry one level at most below the one before. */
function navList(entries: EpubTocEntry[]): string {
  let html = "";
  let depth = 0;
  for (const entry of entries) {
    const target = entry.depth ?? 1;
    if (target > depth) html += "<ol>";
    else html += "</li>" + "</ol></li>".repeat(depth - target);
    depth = target;
    html += `<li><a href="${entry.href}">${entry.label}</a>`;
  }
  return html + "</li></ol>".repeat(depth);
}

export function chapterXhtml(body: string, title = "Book Title"): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
    `<head><title>${title}</title><style>p { color: red; }</style></head>` +
    `<body>${body}</body></html>`
  );
}

export function buildEpub(options: {
  title?: string;
  creators?: string[];
  spine: EpubSpineItem[];
  nav?: EpubTocEntry[];
  ncx?: EpubTocEntry[];
  /** Other archive files (images, encryption.xml), by path from the archive root. */
  files?: Record<string, string | Buffer>;
  /** Manifest entries for `files` under OEBPS/, by path relative to it. */
  manifest?: Record<string, string>;
}): Buffer {
  const items: string[] = [];
  const itemrefs: string[] = [];
  options.spine.forEach((item, index) => {
    items.push(`<item id="c${index}" href="${item.path}" media-type="application/xhtml+xml"/>`);
    itemrefs.push(`<itemref idref="c${index}"${item.linear === false ? ' linear="no"' : ""}/>`);
  });
  for (const [href, mediaType] of Object.entries(options.manifest ?? {})) {
    items.push(`<item id="m${items.length}" href="${href}" media-type="${mediaType}"/>`);
  }
  const files: Record<string, string | Buffer> = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml":
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ...options.files,
  };
  for (const item of options.spine) files[`OEBPS/${item.path}`] = item.xhtml;

  if (options.nav) {
    items.push(
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    );
    files["OEBPS/nav.xhtml"] = chapterXhtml(
      '<nav epub:type="landmarks"><ol><li><a href="cover.xhtml">Cover</a></li></ol></nav>' +
        `<nav epub:type="toc"><h1>Contents</h1>${navList(options.nav)}</nav>`
    );
  }
  if (options.ncx) {
    items.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
    const points = options.ncx
      .map(
        (entry, index) =>
          `<navPoint id="p${index}" playOrder="${index + 1}"><navLabel><text>${entry.label}</text></navLabel><content src="${entry.href}"/></navPoint>`
      )
      .join("");
    files["OEBPS/toc.ncx"] =
      '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">' +
      `<docTitle><text>${options.title ?? ""}</text></docTitle><navMap>${points}</navMap></ncx>`;
  }

  const metadata = [
    options.title ? `<dc:title>${options.title}</dc:title>` : "",
    ...(options.creators ?? []).map((creator) => `<dc:creator>${creator}</dc:creator>`),
  ].join("");
  files["OEBPS/content.opf"] =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">' +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:test</dc:identifier>${metadata}</metadata>` +
    `<manifest>${items.join("")}</manifest>` +
    `<spine${options.ncx ? ' toc="ncx"' : ""}>${itemrefs.join("")}</spine></package>`;

  return buildZip(files);
}

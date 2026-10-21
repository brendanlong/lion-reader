/**
 * `.epub` → one HTML article per chapter, for ebook imports (#1805).
 *
 * An EPUB is a ZIP: `META-INF/container.xml` names the package document (OPF),
 * whose spine lists the book's XHTML files in reading order, and whose table of
 * contents (an EPUB 3 nav document or an EPUB 2 NCX) names its chapters. A
 * chapter runs from where its table-of-contents entry points to the next
 * chapter's: converters both split one chapter across files and put several
 * chapters in one file, so chapters are cut at the entries' anchors, not at
 * file boundaries.
 *
 * Chapters are read one at a time ({@link Epub.chapters}), so a whole book's
 * HTML is never in memory at once. Every byte inflated from the archive counts
 * against one budget, which bounds what a ZIP bomb can cost.
 */

import { posix } from "node:path";
import JSZip from "jszip";
import { usageLimitsConfig } from "@/server/config/env";
import { errors } from "@/server/errors";
import { escapeHtml } from "@/server/http/html";
import { createSaxParser } from "@/server/html/sax";

/**
 * Everything inflated from one book, as a multiple of the saved-article size
 * limit, the same allowance a `.docx` gets: the upload itself is capped at that
 * limit, and its images barely compress.
 */
const EPUB_MAX_INFLATION_FACTOR = 10;

/**
 * Most chapters one book may have. Each becomes an article saved in the import
 * request, so this bounds the request's time.
 */
const EPUB_MAX_CHAPTERS = 1000;

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is never part of the article. */
const SKIPPED_ELEMENTS = new Set(["script", "style", "noscript"]);

const ATTRIBUTE_NAME = /^[a-z_][a-z0-9_.:-]*$/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const HEADING = /^h[1-6]$/;

export interface EpubChapter {
  /** The table of contents' label, else the chapter's first heading. */
  title: string | null;
  html: string;
}

export interface Epub {
  title: string | null;
  author: string | null;
  /** The book's chapters in reading order, skipping any without text or images. */
  chapters(): AsyncGenerator<EpubChapter>;
}

interface ManifestItem {
  path: string;
  mediaType: string;
  properties: string[];
}

interface Package {
  title: string | null;
  creators: string[];
  manifest: Map<string, ManifestItem>;
  /** Paths of the linear spine documents, in reading order. */
  spine: string[];
  /** The manifest id of the EPUB 2 NCX, from the spine's `toc` attribute. */
  ncxId: string | null;
}

/** Reads archive entries, failing once their inflated total passes the budget. */
class BudgetedZip {
  private inflated = 0;
  private readonly budget = usageLimitsConfig.maxSavedArticleSizeBytes * EPUB_MAX_INFLATION_FACTOR;

  constructor(private readonly zip: JSZip) {}

  has(path: string): boolean {
    const entry = this.zip.file(path);
    return entry !== null && !entry.dir;
  }

  async readText(path: string): Promise<string | null> {
    const bytes = await this.read(path);
    return bytes === null ? null : bytes.toString("utf8");
  }

  /**
   * Counts the bytes actually inflated rather than trusting the sizes the ZIP
   * declares, which the file's author controls.
   */
  read(path: string): Promise<Buffer | null> {
    const entry = this.zip.file(path);
    if (!entry || entry.dir) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = entry.nodeStream();
      stream.on("data", (chunk: Buffer) => {
        this.inflated += chunk.length;
        if (this.inflated > this.budget) {
          stream.pause();
          reject(errors.contentTooLarge("Decompressed ebook", this.budget));
          return;
        }
        chunks.push(chunk);
      });
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  }
}

/** An element or attribute name without its namespace prefix. */
function localName(name: string): string {
  const colon = name.lastIndexOf(":");
  return (colon === -1 ? name : name.slice(colon + 1)).toLowerCase();
}

/** The archive path a document's relative reference points to, and its fragment. */
function resolveReference(
  fromPath: string,
  href: string
): { path: string; fragment: string | null } | null {
  if (URL_SCHEME.test(href) || href.startsWith("/")) return null;
  const hashIndex = href.indexOf("#");
  const pathPart = hashIndex === -1 ? href : href.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? null : href.slice(hashIndex + 1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  if (decoded === "") return { path: fromPath, fragment };
  const path = posix.normalize(posix.join(posix.dirname(fromPath), decoded));
  return path.startsWith("../") ? null : { path, fragment };
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseXml(
  xml: string,
  handlers: {
    open?: (name: string, attrs: Record<string, string>) => void;
    close?: (name: string) => void;
    text?: (text: string) => void;
  }
): void {
  const parser = createSaxParser(
    {
      onopentag: (name, attrs) => handlers.open?.(localName(name), attrs),
      onclosetag: (name) => handlers.close?.(localName(name)),
      ontext: (text) => handlers.text?.(text),
    },
    { xmlMode: true }
  );
  parser.write(xml);
  parser.end();
}

function attribute(attrs: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(attrs)) {
    if (localName(key) === name) return value;
  }
  return undefined;
}

function findPackagePath(containerXml: string): string | null {
  let path: string | null = null;
  parseXml(containerXml, {
    open(name, attrs) {
      if (name === "rootfile" && path === null) path = attrs["full-path"] ?? null;
    },
  });
  return path;
}

function parsePackage(opfPath: string, opf: string): Package {
  const manifest = new Map<string, ManifestItem>();
  const spineIds: string[] = [];
  const creators: string[] = [];
  let title: string | null = null;
  let ncxId: string | null = null;
  let inMetadata = false;
  let field: { name: "title" | "creator"; text: string } | null = null;

  parseXml(opf, {
    open(name, attrs) {
      if (name === "metadata") inMetadata = true;
      else if (inMetadata && (name === "title" || name === "creator")) field = { name, text: "" };
      else if (name === "item" && attrs.id && attrs.href) {
        const resolved = resolveReference(opfPath, attrs.href);
        if (resolved) {
          manifest.set(attrs.id, {
            path: resolved.path,
            mediaType: (attrs["media-type"] ?? "").toLowerCase(),
            properties: (attrs.properties ?? "").split(/\s+/),
          });
        }
      } else if (name === "spine") ncxId = attrs.toc ?? null;
      else if (name === "itemref" && attrs.idref && attrs.linear !== "no") {
        spineIds.push(attrs.idref);
      }
    },
    text(text) {
      if (field) field.text += text;
    },
    close(name) {
      if (name === "metadata") inMetadata = false;
      if (field && name === field.name) {
        const value = collapseWhitespace(field.text);
        if (value && field.name === "title") title ??= value;
        if (value && field.name === "creator") creators.push(value);
        field = null;
      }
    },
  });

  const spine = spineIds
    .map((id) => manifest.get(id))
    .filter((item) => item !== undefined)
    .map((item) => item.path);
  return { title, creators, manifest, spine, ncxId };
}

interface TocEntry {
  path: string;
  fragment: string | null;
  label: string;
  /** 1 for a top-level entry. */
  depth: number;
}

/** The `<a href>`s of an EPUB 3 nav document's `toc` nav (or its first nav). */
function parseNav(navPath: string, nav: string): TocEntry[] {
  const byNav: { isToc: boolean; entries: TocEntry[] }[] = [];
  let current: { isToc: boolean; entries: TocEntry[] } | null = null;
  let navDepth = 0;
  let listDepth = 0;
  let link: { href: string; text: string } | null = null;

  parseXml(nav, {
    open(name, attrs) {
      if (name === "nav") {
        if (navDepth++ === 0) {
          const types = (attribute(attrs, "type") ?? "").split(/\s+/);
          current = { isToc: types.includes("toc"), entries: [] };
          byNav.push(current);
        }
      } else if (name === "ol" && current) {
        listDepth++;
      } else if (name === "a" && current && attrs.href) {
        link = { href: attrs.href, text: "" };
      }
    },
    text(text) {
      if (link) link.text += text;
    },
    close(name) {
      if (name === "nav" && --navDepth === 0) current = null;
      else if (name === "ol" && current) listDepth--;
      else if (name === "a" && link && current) {
        const resolved = resolveReference(navPath, link.href);
        if (resolved) {
          current.entries.push({ ...resolved, label: link.text, depth: Math.max(listDepth, 1) });
        }
        link = null;
      }
    },
  });

  return (byNav.find((n) => n.isToc) ?? byNav[0])?.entries ?? [];
}

/** The navPoints of an EPUB 2 NCX, in document order. */
function parseNcx(ncxPath: string, ncx: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const labels: string[] = [];
  let inLabelText = false;

  parseXml(ncx, {
    open(name, attrs) {
      if (name === "navpoint") labels.push("");
      else if (name === "text" && labels.length > 0) inLabelText = true;
      else if (name === "content" && attrs.src && labels.length > 0) {
        const resolved = resolveReference(ncxPath, attrs.src);
        if (resolved) {
          entries.push({ ...resolved, label: labels[labels.length - 1], depth: labels.length });
        }
      }
    },
    text(text) {
      if (inLabelText) labels[labels.length - 1] += text;
    },
    close(name) {
      if (name === "navpoint") labels.pop();
      else if (name === "text") inLabelText = false;
    },
  });
  return entries;
}

async function readToc(zip: BudgetedZip, pkg: Package): Promise<TocEntry[]> {
  const nav = [...pkg.manifest.values()].find((item) => item.properties.includes("nav"));
  if (nav) {
    const xml = await zip.readText(nav.path);
    const entries = xml ? parseNav(nav.path, xml) : [];
    if (entries.length > 0) return entries;
  }
  const ncx =
    (pkg.ncxId ? pkg.manifest.get(pkg.ncxId) : undefined) ??
    [...pkg.manifest.values()].find((item) => item.mediaType === "application/x-dtbncx+xml");
  if (!ncx) return [];
  const xml = await zip.readText(ncx.path);
  return xml ? parseNcx(ncx.path, xml) : [];
}

/** Where chapters start in one spine document, with their labels. */
interface DocumentCuts {
  /** Set when a chapter starts with the document. */
  atStart?: string | null;
  /** Chapters starting at an element, by its id. */
  anchors: Map<string, string | null>;
}

/**
 * Where the book's chapters start. The chapter level is the shallowest level
 * of the table of contents with more than one entry (a lone top-level entry is
 * usually the book itself): its entries, and those above it, start chapters,
 * and so does any entry pointing at the start of a document (a part's title
 * page, say). A deeper entry pointing into a document is a section of its
 * chapter. Without a table of contents, each document is a chapter.
 */
function findChapterStarts(spine: string[], toc: TocEntry[]): Map<string, DocumentCuts> {
  const inSpine = new Set(spine);
  const entries = toc.filter((entry) => inSpine.has(entry.path));
  const cuts = new Map<string, DocumentCuts>();
  if (entries.length === 0) {
    for (const path of spine) cuts.set(path, { atStart: null, anchors: new Map() });
    return cuts;
  }

  const perDepth = new Map<number, number>();
  for (const { depth } of entries) perDepth.set(depth, (perDepth.get(depth) ?? 0) + 1);
  const depths = [...perDepth.keys()].sort((a, b) => a - b);
  const chapterDepth = depths.find((depth) => perDepth.get(depth)! > 1) ?? depths[0];

  for (const entry of entries) {
    if (entry.depth > chapterDepth && entry.fragment) continue;
    let doc = cuts.get(entry.path);
    if (!doc) {
      doc = { anchors: new Map() };
      cuts.set(entry.path, doc);
    }
    const label = collapseWhitespace(entry.label) || null;
    if (!entry.fragment) doc.atStart ??= label;
    else if (!doc.anchors.has(entry.fragment)) doc.anchors.set(entry.fragment, label);
  }
  return cuts;
}

/**
 * Spine documents META-INF/encryption.xml lists. Fonts are often obfuscated
 * (which is harmless to us); an encrypted document means DRM.
 */
async function encryptedPaths(zip: BudgetedZip): Promise<Set<string>> {
  const xml = await zip.readText("META-INF/encryption.xml");
  const paths = new Set<string>();
  if (!xml) return paths;
  parseXml(xml, {
    open(name, attrs) {
      if (name === "cipherreference" && attrs.URI) {
        const resolved = resolveReference("", attrs.URI);
        if (resolved) paths.add(resolved.path);
      }
    },
  });
  return paths;
}

type HtmlPart = string | { image: string };

interface PendingChapter {
  label: string | null;
  heading: string | null;
  parts: HtmlPart[];
}

/** An element open where a chapter is cut, which both sides of the cut need. */
interface OpenElement {
  name: string;
  openTag: HtmlPart[];
  /** Where its open tag is in the current chapter's parts. */
  index: number;
}

/**
 * Builds chapters from the book's spine documents in order, converting each
 * document's `<body>` from XHTML to HTML. Book images become placeholders
 * ({@link inlineImages}); links into the book keep only their fragment, which
 * works when the target is in the same chapter and is harmless otherwise.
 */
class ChapterBuilder {
  /** Chapters finished since the last {@link takeFinished}. */
  private finished: PendingChapter[] = [];
  private current: PendingChapter = { label: null, heading: null, parts: [] };

  takeFinished(): PendingChapter[] {
    const finished = this.finished;
    this.finished = [];
    return finished;
  }

  /** Ends the book, returning its last chapter. */
  finish(): PendingChapter[] {
    this.cut(this.current.parts.length, [], null);
    return this.takeFinished();
  }

  /**
   * Starts a new chapter at `index` in the current one's parts, closing the
   * elements open there in the old chapter and reopening them in the new.
   */
  private cut(index: number, open: OpenElement[], label: string | null): void {
    const before = open.filter((element) => element.index < index);
    const old = this.current;
    const closers = before
      .slice()
      .reverse()
      .map((element) => `</${element.name}>`);
    const oldParts = [...old.parts.slice(0, index), ...closers];
    if (hasContent(oldParts)) this.finished.push({ ...old, parts: oldParts });

    const reopened: HtmlPart[] = [];
    for (const element of before) {
      element.index = reopened.length;
      reopened.push(...element.openTag);
    }
    for (const element of open) {
      if (!before.includes(element)) element.index += reopened.length - index;
    }
    this.current = { label, heading: null, parts: [...reopened, ...old.parts.slice(index)] };
  }

  addDocument(path: string, xhtml: string, cuts: DocumentCuts | undefined): void {
    if (cuts?.atStart !== undefined) this.cut(this.current.parts.length, [], cuts.atStart);

    const open: OpenElement[] = [];
    let inBody = false;
    let skipDepth = 0;
    let heading: { text: string; depth: number } | null = null;
    // Where the run of open tags (and whitespace) just before this point
    // starts: a chapter starting here starts there instead, so it takes the
    // elements wrapping its anchor rather than leaving them empty behind.
    let runStart = this.current.parts.length;
    const parts = () => this.current.parts;

    const parser = createSaxParser(
      {
        onopentag: (rawName, attrs) => {
          const name = rawName.toLowerCase();
          if (!inBody) {
            inBody = name === "body";
            runStart = parts().length;
            return;
          }
          if (skipDepth > 0 || SKIPPED_ELEMENTS.has(name)) {
            skipDepth++;
            return;
          }

          const anchor = attrs.id ?? (name === "a" ? attrs.name : undefined);
          if (anchor !== undefined && cuts?.anchors.has(anchor)) {
            this.cut(runStart, open, cuts.anchors.get(anchor) ?? null);
            runStart = 0;
            if (heading) heading = { text: "", depth: heading.depth };
          }
          if (HEADING.test(name) && heading === null && this.current.heading === null) {
            heading = { text: "", depth: open.length };
          }

          let tag = `<${name}`;
          let image: { key: string; path: string } | null = null;
          for (const [rawKey, value] of Object.entries(attrs)) {
            const key = rawKey.toLowerCase();
            if (!ATTRIBUTE_NAME.test(key)) continue;
            const isImageSource =
              (name === "img" && key === "src") ||
              (name === "image" && (key === "href" || key === "xlink:href"));
            if (isImageSource) {
              const resolved = resolveReference(path, value);
              if (resolved) {
                image = { key, path: resolved.path };
                continue;
              }
            } else if (name === "a" && key === "href" && !URL_SCHEME.test(value)) {
              const fragment = resolveReference(path, value)?.fragment;
              if (fragment) tag += ` href="#${escapeHtml(fragment)}"`;
              continue;
            }
            tag += ` ${key}="${escapeHtml(value)}"`;
          }

          const openTag: HtmlPart[] = image
            ? [`${tag} ${image.key}="`, { image: image.path }, `">`]
            : [`${tag}>`];
          const index = parts().length;
          parts().push(...openTag);
          if (VOID_ELEMENTS.has(name)) {
            runStart = parts().length;
          } else {
            open.push({ name, openTag, index });
          }
        },
        ontext: (text) => {
          if (!inBody || skipDepth > 0) return;
          if (heading) heading.text += text;
          parts().push(escapeHtml(text));
          if (text.trim() !== "") runStart = parts().length;
        },
        onclosetag: (rawName) => {
          const name = rawName.toLowerCase();
          if (!inBody) return;
          if (skipDepth > 0) {
            skipDepth--;
            return;
          }
          if (name === "body" && open.length === 0) {
            inBody = false;
            return;
          }
          if (VOID_ELEMENTS.has(name)) return;
          open.pop();
          if (heading && heading.depth === open.length) {
            this.current.heading ??= collapseWhitespace(heading.text) || null;
            heading = null;
          }
          parts().push(`</${name}>`);
          runStart = parts().length;
        },
      },
      // XHTML: `<div/>` is an empty div, not an open one.
      { recognizeSelfClosing: true }
    );
    parser.write(xhtml);
    parser.end();
  }
}

function imageMediaType(manifestType: string | undefined, path: string): string | null {
  if (manifestType?.startsWith("image/")) return manifestType;
  const extension = posix.extname(path).toLowerCase();
  const byExtension: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
  };
  return byExtension[extension] ?? null;
}

/**
 * Inlines the chapter's images as data URIs, in order, while the chapter stays
 * within the saved-article size limit; images past it are dropped.
 */
async function inlineImages(
  zip: BudgetedZip,
  mediaTypes: Map<string, string>,
  parts: HtmlPart[]
): Promise<string> {
  let remaining =
    usageLimitsConfig.maxSavedArticleSizeBytes -
    parts.reduce((sum, part) => sum + (typeof part === "string" ? part.length : 0), 0);
  let html = "";
  for (const part of parts) {
    if (typeof part === "string") {
      html += part;
      continue;
    }
    const mediaType = imageMediaType(mediaTypes.get(part.image), part.image);
    const data = mediaType ? await zip.read(part.image) : null;
    if (!mediaType || !data) continue;
    const uri = `data:${mediaType};base64,${data.toString("base64")}`;
    if (uri.length > remaining) continue;
    remaining -= uri.length;
    html += uri;
  }
  return html;
}

/** Whether the converted HTML has anything to read or look at. */
function hasContent(parts: HtmlPart[]): boolean {
  let text = "";
  for (const part of parts) {
    if (typeof part !== "string") return true;
    text += part;
  }
  return text.replace(/<[^>]*>/g, "").trim() !== "";
}

/**
 * Opens an EPUB, reading its package and table of contents. Throws an error
 * whose message is meant for the user when the file isn't a readable EPUB.
 */
export async function openEpub(buffer: Buffer): Promise<Epub> {
  let jszip: JSZip;
  try {
    jszip = await JSZip.loadAsync(buffer);
  } catch {
    throw new Error("Not an EPUB file (it isn't a ZIP archive)");
  }
  const zip = new BudgetedZip(jszip);

  const container = await zip.readText("META-INF/container.xml");
  const opfPath = container ? findPackagePath(container) : null;
  const opf = opfPath ? await zip.readText(opfPath) : null;
  if (!opfPath || !opf) {
    throw new Error("Not an EPUB file (it has no package document)");
  }
  const pkg = parsePackage(opfPath, opf);
  const spine = pkg.spine.filter((path) => zip.has(path));
  if (spine.length === 0) {
    throw new Error("The ebook has no chapters");
  }
  const encrypted = await encryptedPaths(zip);
  if (spine.some((path) => encrypted.has(path))) {
    throw new Error("The ebook is DRM-protected");
  }

  const starts = findChapterStarts(spine, await readToc(zip, pkg));
  // Content before the first start is a chapter of its own.
  let maxChapters = 1;
  for (const doc of starts.values()) {
    maxChapters += doc.anchors.size + (doc.atStart !== undefined ? 1 : 0);
  }
  if (maxChapters > EPUB_MAX_CHAPTERS) {
    throw new Error(`The ebook has more than ${EPUB_MAX_CHAPTERS} chapters`);
  }
  const mediaTypes = new Map([...pkg.manifest.values()].map((item) => [item.path, item.mediaType]));

  async function toChapter(pending: PendingChapter): Promise<EpubChapter> {
    return {
      title: pending.label ?? pending.heading,
      html: await inlineImages(zip, mediaTypes, pending.parts),
    };
  }

  return {
    title: pkg.title,
    author: pkg.creators.length > 0 ? pkg.creators.join(", ") : null,
    async *chapters() {
      const builder = new ChapterBuilder();
      for (const path of spine) {
        const xhtml = await zip.readText(path);
        if (xhtml) builder.addDocument(path, xhtml, starts.get(path));
        for (const pending of builder.takeFinished()) yield await toChapter(pending);
      }
      for (const pending of builder.finish()) yield await toChapter(pending);
    },
  };
}

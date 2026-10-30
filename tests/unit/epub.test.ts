/**
 * `.epub` parsing for ebook imports (#1805): chapters from the spine and table
 * of contents, the XHTML → HTML conversion, and the archive's resource bounds.
 */

import { describe, it, expect } from "vitest";
import {
  EPUB_MAX_INFLATION_FACTOR,
  EPUB_MAX_TEXT_FACTOR,
  openEpub,
  type ImageStore,
} from "@/server/file/epub";
import { usageLimitsConfig } from "@/server/config/env";
import { getAppErrorCode } from "@/server/errors";
import { buildEpub, chapterXhtml } from "../utils/epub";
import { buildZip } from "../utils/docx";

interface ReadChapter {
  title: string | null;
  html: string;
}

/** A store that names each image it's given `https://bucket.test/{n}{extension}`. */
function testStore(): ImageStore {
  let stored = 0;
  return async (image) => `https://bucket.test/${++stored}${image.extension}`;
}

/** An SVG of about `bytes`, which chapters inline. */
function svgOfSize(bytes: number): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><!--${"a".repeat(bytes)}--></svg>`);
}

async function readChapters(epub: Buffer, store = testStore()): Promise<ReadChapter[]> {
  const book = await openEpub(epub);
  const chapters: ReadChapter[] = [];
  for await (const chapter of book.chapters()) {
    chapters.push({ title: chapter.title, html: await chapter.html(store) });
  }
  return chapters;
}

async function openError(epub: Buffer): Promise<unknown> {
  try {
    await readChapters(epub);
  } catch (error) {
    return error;
  }
  throw new Error("expected the ebook to be rejected");
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("openEpub", () => {
  it("reads the title and every creator", async () => {
    const book = await openEpub(
      buildEpub({
        title: "The Book",
        creators: ["Ann Author", "Bo Writer"],
        spine: [{ path: "one.xhtml", xhtml: chapterXhtml("<p>Text</p>") }],
      })
    );
    expect(book.title).toBe("The Book");
    expect(book.author).toBe("Ann Author, Bo Writer");
  });

  it("starts a chapter at each document the nav points to, and continues it through the rest", async () => {
    const chapters = await readChapters(
      buildEpub({
        spine: [
          { path: "cover.xhtml", xhtml: chapterXhtml("<p>Cover page</p>") },
          { path: "text/one.xhtml", xhtml: chapterXhtml("<p>First part</p>") },
          { path: "text/one-split.xhtml", xhtml: chapterXhtml("<p>First, continued</p>") },
          { path: "notes.xhtml", xhtml: chapterXhtml("<p>Aside</p>"), linear: false },
          { path: "text/two.xhtml", xhtml: chapterXhtml("<p>Second part</p>") },
        ],
        nav: [
          { href: "text/one.xhtml", label: "Chapter  One" },
          { href: "text/one.xhtml#section", label: "A section" },
          { href: "text/two.xhtml", label: "Chapter Two" },
        ],
      })
    );
    expect(chapters.map((chapter) => chapter.title)).toEqual([null, "Chapter One", "Chapter Two"]);
    expect(chapters[1].html).toContain("First part");
    expect(chapters[1].html).toContain("First, continued");
    expect(chapters.map((chapter) => chapter.html).join("")).not.toContain("Aside");
  });

  it("cuts chapters at their anchors, closing and reopening the elements around the cut", async () => {
    const chapters = await readChapters(
      buildEpub({
        spine: [
          {
            path: "all.xhtml",
            xhtml: chapterXhtml(
              '<section><div class="chapter"><h2 id="c1">One</h2><p>First.</p></div>' +
                '<div class="chapter"><h2 id="c2">Two</h2><p>Second.</p>' +
                '<p>More.</p><h3 id="c3">Three</h3><p>Third.</p></div></section>'
            ),
          },
        ],
        nav: [
          { href: "all.xhtml#c1", label: "One" },
          { href: "all.xhtml#c2", label: "Two" },
          { href: "all.xhtml#c3", label: "Three" },
        ],
      })
    );
    expect(chapters).toEqual([
      {
        title: "One",
        html: '<section><div class="chapter"><h2 id="c1">One</h2><p>First.</p></div></section>',
      },
      {
        title: "Two",
        html: '<section><div class="chapter"><h2 id="c2">Two</h2><p>Second.</p><p>More.</p></div></section>',
      },
      {
        title: "Three",
        html: '<section><div class="chapter"><h3 id="c3">Three</h3><p>Third.</p></div></section>',
      },
    ]);
  });

  it.each([
    {
      shape: "a lone top-level entry's children are the chapters",
      nav: [
        { href: "a.xhtml", label: "The Book" },
        { href: "a.xhtml#c1", label: "One", depth: 2 },
        { href: "a.xhtml#c2", label: "Two", depth: 2 },
      ],
      titles: ["One", "Two"],
    },
    {
      shape: "a chapter's sections stay in it",
      nav: [
        { href: "a.xhtml#c1", label: "One" },
        { href: "a.xhtml#s1", label: "Section", depth: 2 },
        { href: "a.xhtml#c2", label: "Two" },
      ],
      titles: ["One", "Two"],
    },
  ])("picks the chapter level of a nested table of contents: $shape", async ({ nav, titles }) => {
    const chapters = await readChapters(
      buildEpub({
        spine: [
          {
            path: "a.xhtml",
            xhtml: chapterXhtml(
              '<h1 id="c1">One</h1><p>A</p><h2 id="s1">Section</h2><p>B</p><h1 id="c2">Two</h1><p>C</p>'
            ),
          },
        ],
        nav,
      })
    );
    expect(chapters.map((chapter) => chapter.title)).toEqual(titles);
  });

  it("reads an EPUB 2 NCX when there's no nav", async () => {
    const chapters = await readChapters(
      buildEpub({
        spine: [
          { path: "a.xhtml", xhtml: chapterXhtml("<p>A</p>") },
          { path: "b.xhtml", xhtml: chapterXhtml("<p>B</p>") },
        ],
        ncx: [
          { href: "a.xhtml", label: "Alpha" },
          { href: "b.xhtml", label: "Beta" },
        ],
      })
    );
    expect(chapters.map((chapter) => chapter.title)).toEqual(["Alpha", "Beta"]);
  });

  it("makes every document a chapter titled by its first heading without a table of contents, skipping empty ones", async () => {
    const chapters = await readChapters(
      buildEpub({
        spine: [
          { path: "a.xhtml", xhtml: chapterXhtml("<h2>The <em>First</em></h2><h1>Later</h1>") },
          { path: "blank.xhtml", xhtml: chapterXhtml("<div> </div>") },
          { path: "b.xhtml", xhtml: chapterXhtml("<p>No heading</p>") },
        ],
      })
    );
    expect(chapters.map((chapter) => chapter.title)).toEqual(["The First", null]);
  });

  it("converts XHTML to HTML: self-closed elements stay empty, text is re-escaped, scripts and styles go", async () => {
    const [chapter] = await readChapters(
      buildEpub({
        spine: [
          {
            path: "a.xhtml",
            xhtml: chapterXhtml(
              '<div id="anchor"/><p>Fish &amp; chips &lt;b&gt;</p><br/><script>alert(1)</script>'
            ),
          },
        ],
      })
    );
    expect(chapter.html).toBe('<div id="anchor"></div><p>Fish &amp; chips &lt;b&gt;</p><br>');
  });

  it("keeps links to the web and to anchors in the book, and unlinks the book's documents", async () => {
    const [first] = await readChapters(
      buildEpub({
        spine: [
          {
            path: "text/a.xhtml",
            xhtml: chapterXhtml(
              '<p><a href="#n1">note</a> <a href="a-split.xhtml#n2">split note</a> ' +
                '<a href="b.xhtml#x">elsewhere</a> <a href="b.xhtml">whole</a> ' +
                '<a href="https://example.com/">web</a></p>'
            ),
          },
          { path: "text/a-split.xhtml", xhtml: chapterXhtml('<p id="n2">Two</p>') },
          { path: "text/b.xhtml", xhtml: chapterXhtml("<p>B</p>") },
        ],
        nav: [
          { href: "text/a.xhtml", label: "A" },
          { href: "text/b.xhtml", label: "B" },
        ],
      })
    );
    expect(first.html).toContain('<a href="#n1">note</a>');
    expect(first.html).toContain('<a href="#n2">split note</a>');
    expect(first.html).toContain('<a href="#x">elsewhere</a>');
    expect(first.html).toContain("<a>whole</a>");
    expect(first.html).toContain('<a href="https://example.com/">web</a>');
  });

  it("resolves an image's path from its document, in <img> and in an SVG's <image>", async () => {
    const [chapter] = await readChapters(
      buildEpub({
        spine: [
          {
            path: "text/a.xhtml",
            xhtml: chapterXhtml(
              '<p><img src="../images/pic.png" alt="Pic"/></p>' +
                '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="../images/pic.png"/></svg>'
            ),
          },
        ],
        files: { "OEBPS/images/pic.png": PNG },
        manifest: { "images/pic.png": "image/png" },
      })
    );
    expect(chapter.html).toContain('<img alt="Pic" src="https://bucket.test/1.png">');
    expect(chapter.html).toContain('<image xlink:href="https://bucket.test/1.png"></image>');
  });

  it("hands raster images to the store, once per chapter, and inlines SVG", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const stored: string[] = [];
    const store: ImageStore = async (image) => {
      stored.push(`${image.mediaType} ${image.extension} ${image.data.toString("hex")}`);
      return `https://bucket.test/${stored.length}${image.extension}`;
    };
    const chapters = await readChapters(
      buildEpub({
        spine: [
          {
            path: "a.xhtml",
            xhtml: chapterXhtml(
              '<p><img src="pic.png"/><img src="pic.png"/><img src="d.svg"/></p>'
            ),
          },
          { path: "b.xhtml", xhtml: chapterXhtml('<p><img src="pic.png"/></p>') },
        ],
        files: { "OEBPS/pic.png": PNG, "OEBPS/d.svg": svg },
        manifest: { "pic.png": "image/png", "d.svg": "image/svg+xml" },
      }),
      store
    );

    expect(stored).toEqual([
      `image/png .png ${PNG.toString("hex")}`,
      `image/png .png ${PNG.toString("hex")}`,
    ]);
    expect(chapters.map((chapter) => chapter.html)).toEqual([
      `<p><img src="https://bucket.test/1.png"><img src="https://bucket.test/1.png">` +
        `<img src="data:image/svg+xml;base64,${svg.toString("base64")}"></p>`,
      '<p><img src="https://bucket.test/2.png"></p>',
    ]);
  });

  it("fails the book once its images pass its storage budget", async () => {
    const limit = usageLimitsConfig.maxSavedArticleSizeBytes;
    const image = Buffer.alloc(Math.floor(limit / 2));
    const storable = Math.floor((limit * EPUB_MAX_INFLATION_FACTOR) / image.length);
    let stored = 0;
    const book = buildEpub({
      spine: Array.from({ length: storable + 1 }, (_, i) => ({
        path: `${i}.xhtml`,
        xhtml: chapterXhtml('<p><img src="pic.png"/></p>'),
      })),
      files: { "OEBPS/pic.png": image },
      manifest: { "pic.png": "image/png" },
    });

    const error = await readChapters(book, async () => `https://bucket.test/${++stored}.png`).then(
      () => null,
      (e: unknown) => e
    );
    expect(getAppErrorCode(error)).toBe("CONTENT_TOO_LARGE");
    expect(stored).toBe(storable);
  });

  it("drops an SVG that would take the chapter past the saved-article size limit", async () => {
    const [chapter] = await readChapters(
      buildEpub({
        spine: [
          {
            path: "a.xhtml",
            xhtml: chapterXhtml('<p>Text</p><img src="big.svg"/><img src="small.svg"/>'),
          },
        ],
        files: {
          "OEBPS/big.svg": svgOfSize(usageLimitsConfig.maxSavedArticleSizeBytes),
          "OEBPS/small.svg": svgOfSize(10),
        },
        manifest: { "big.svg": "image/svg+xml", "small.svg": "image/svg+xml" },
      })
    );
    expect(chapter.html.length).toBeLessThanOrEqual(usageLimitsConfig.maxSavedArticleSizeBytes);
    expect(chapter.html).toContain(svgOfSize(10).toString("base64"));
  });

  describe("resource bounds", () => {
    const limit = usageLimitsConfig.maxSavedArticleSizeBytes;
    /** A document that inflates to about `bytes` but converts to almost nothing. */
    const paddedDocument = (bytes: number) =>
      chapterXhtml(`<p>Short.</p><!--${"a".repeat(bytes)}-->`);

    it("rejects a book whose documents together pass its text budget", async () => {
      const perDocument = Math.ceil((limit * EPUB_MAX_TEXT_FACTOR) / 2);
      const error = await openError(
        buildEpub({
          spine: [
            { path: "a.xhtml", xhtml: paddedDocument(perDocument) },
            { path: "b.xhtml", xhtml: paddedDocument(perDocument) },
          ],
        })
      );
      expect(getAppErrorCode(error)).toBe("CONTENT_TOO_LARGE");
      expect((error as Error).message).toMatch(/text/);
    });

    it("drops an inlined SVG once the book's chapters have saved its text budget", async () => {
      // Small enough to fit one chapter, inlined in more chapters than the budget holds.
      const svgBytes = Math.floor(limit * 0.4);
      const chapterCount = Math.ceil((limit * EPUB_MAX_TEXT_FACTOR) / svgBytes) + 1;
      const chapters = await readChapters(
        buildEpub({
          spine: Array.from({ length: chapterCount }, (_, i) => ({
            path: `${i}.xhtml`,
            xhtml: chapterXhtml('<p>Text</p><img src="pic.svg"/>'),
          })),
          files: { "OEBPS/pic.svg": svgOfSize(svgBytes) },
          manifest: { "pic.svg": "image/svg+xml" },
        })
      );
      const saved = chapters.reduce((sum, chapter) => sum + Buffer.byteLength(chapter.html), 0);
      expect(saved).toBeLessThanOrEqual(limit * EPUB_MAX_TEXT_FACTOR);
      expect(chapters[0].html).toContain("data:image/svg+xml");
      expect(chapters.at(-1)!.html).not.toContain("data:image/svg+xml");
    });

    it("rejects a book whose archive inflates past its budget", async () => {
      const error = await openError(
        buildEpub({
          spine: [{ path: "a.xhtml", xhtml: chapterXhtml('<p>Text</p><img src="pic.png"/>') }],
          files: { "OEBPS/pic.png": Buffer.alloc(limit * EPUB_MAX_INFLATION_FACTOR + 1) },
          manifest: { "pic.png": "image/png" },
        })
      );
      expect(getAppErrorCode(error)).toBe("CONTENT_TOO_LARGE");
      expect((error as Error).message).toMatch(/Decompressed ebook/);
    });

    it("rejects a chapter too large to save as soon as it's read", async () => {
      const error = await openError(
        buildEpub({
          spine: [{ path: "a.xhtml", xhtml: chapterXhtml(`<p>${"a".repeat(limit + 1)}</p>`) }],
        })
      );
      expect(getAppErrorCode(error)).toBe("CONTENT_TOO_LARGE");
    });

    it("reads an image once, however many chapters show it", async () => {
      const image = svgOfSize(Math.floor(limit / 2));
      const count = Math.floor((limit * EPUB_MAX_INFLATION_FACTOR) / image.length) + 1;
      const chapters = await readChapters(
        buildEpub({
          spine: Array.from({ length: count }, (_, i) => ({
            path: `${i}.xhtml`,
            xhtml: chapterXhtml('<p>Text</p><img src="pic.svg"/>'),
          })),
          files: { "OEBPS/pic.svg": image },
          manifest: { "pic.svg": "image/svg+xml" },
        })
      );
      // Read for each chapter, it would pass the archive's inflation budget.
      expect(chapters).toHaveLength(count);
    });

    it("budgets a chapter's inlined images by its text's UTF-8 bytes", async () => {
      // A third of the limit in characters is the whole limit in bytes.
      const text = "章".repeat(Math.floor(limit / 3) - 64);
      const [chapter] = await readChapters(
        buildEpub({
          spine: [{ path: "a.xhtml", xhtml: chapterXhtml(`<p>${text}</p><img src="pic.svg"/>`) }],
          files: { "OEBPS/pic.svg": svgOfSize(1024) },
          manifest: { "pic.svg": "image/svg+xml" },
        })
      );
      expect(chapter.html).not.toContain("data:image/svg+xml");
      expect(Buffer.byteLength(chapter.html)).toBeLessThanOrEqual(limit);
    });
  });

  it("rejects a DRM-protected book, but not one with obfuscated fonts", async () => {
    const encryption = (uri: string) =>
      '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">' +
      `<enc:EncryptedData><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData></encryption>`;
    const book = (uri: string) =>
      buildEpub({
        spine: [{ path: "a.xhtml", xhtml: chapterXhtml("<p>A</p>") }],
        files: { "META-INF/encryption.xml": encryption(uri) },
      });

    expect(String(await openError(book("OEBPS/a.xhtml")))).toMatch(/DRM/);
    await expect(readChapters(book("OEBPS/fonts/font.otf"))).resolves.toHaveLength(1);
  });

  it.each([
    ["isn't a ZIP", Buffer.from("not a zip"), /isn't a ZIP/],
    ["has no package document", buildZip({ mimetype: "application/epub+zip" }), /package/],
    ["has an empty spine", buildEpub({ spine: [] }), /no chapters/],
  ])("rejects a file that %s", async (_label, file, message) => {
    await expect(openEpub(file)).rejects.toThrow(message);
  });

  it("writes only markup it built: an image type is one we know, and an element name HTML can spell", async () => {
    const [chapter] = await readChapters(
      buildEpub({
        spine: [
          {
            path: "a.xhtml",
            xhtml: chapterXhtml('<p><img src="pic.png"/><x"y>kept text</x"y></p>'),
          },
        ],
        files: { "OEBPS/pic.png": PNG },
        manifest: { "pic.png": "image/png&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;" },
      })
    );
    expect(chapter.html).toBe('<p><img src="https://bucket.test/1.png">kept text</p>');
  });

  it("drops a reference that decodes to the NUL marking images", async () => {
    const [chapter] = await readChapters(
      buildEpub({
        spine: [
          {
            path: "a.xhtml",
            xhtml: chapterXhtml(
              '<p>x<a href="#a%00b">link</a><img src="a%00%3Cscript%3E%00.png"/>' +
                '<img src="pic.png"/></p>'
            ),
          },
        ],
        files: { "OEBPS/pic.png": PNG },
        manifest: { "pic.png": "image/png" },
      })
    );
    expect(chapter.html).toBe('<p>x<a>link</a><img><img src="https://bucket.test/1.png"></p>');
  });

  it("cuts at an anchor on <body> and at a percent-encoded fragment", async () => {
    const chapters = await readChapters(
      buildEpub({
        spine: [
          { path: "a.xhtml", xhtml: chapterXhtml("<p>One</p>") },
          {
            path: "b.xhtml",
            xhtml: chapterXhtml('<p>Two</p><h2 id="章">Three</h2>').replace(
              "<body>",
              '<body id="c2">'
            ),
          },
        ],
        nav: [
          { href: "a.xhtml", label: "One" },
          { href: "b.xhtml#c2", label: "Two" },
          { href: "b.xhtml#%E7%AB%A0", label: "Three" },
        ],
      })
    );
    expect(chapters.map((chapter) => chapter.title)).toEqual(["One", "Two", "Three"]);
  });
});

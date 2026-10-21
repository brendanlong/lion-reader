/**
 * `.epub` parsing for ebook imports (#1805): chapters from the spine and table
 * of contents, the XHTML → HTML conversion, and the archive's resource bounds.
 */

import { describe, it, expect } from "vitest";
import { openEpub, type EpubChapter } from "@/server/file/epub";
import { usageLimitsConfig } from "@/server/config/env";
import { getAppErrorCode } from "@/server/errors";
import { buildEpub, chapterXhtml } from "../utils/epub";
import { buildZip } from "../utils/docx";

async function readChapters(epub: Buffer): Promise<EpubChapter[]> {
  const book = await openEpub(epub);
  const chapters: EpubChapter[] = [];
  for await (const chapter of book.chapters()) chapters.push(chapter);
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

  it("inlines the book's images, including an SVG cover's", async () => {
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
    const uri = `data:image/png;base64,${PNG.toString("base64")}`;
    expect(chapter.html).toContain(`<img alt="Pic" src="${uri}">`);
    expect(chapter.html).toContain(`<image xlink:href="${uri}"></image>`);
  });

  it("drops an image that would take the chapter past the saved-article size limit", async () => {
    const big = Buffer.alloc(usageLimitsConfig.maxSavedArticleSizeBytes);
    const [chapter] = await readChapters(
      buildEpub({
        spine: [
          {
            path: "a.xhtml",
            xhtml: chapterXhtml('<p>Text</p><img src="big.png"/><img src="small.png"/>'),
          },
        ],
        files: { "OEBPS/big.png": big, "OEBPS/small.png": PNG },
        manifest: { "big.png": "image/png", "small.png": "image/png" },
      })
    );
    expect(chapter.html.length).toBeLessThanOrEqual(usageLimitsConfig.maxSavedArticleSizeBytes);
    expect(chapter.html).toContain(PNG.toString("base64"));
  });

  it("rejects a book that inflates past its budget", async () => {
    const bomb = "a".repeat(usageLimitsConfig.maxSavedArticleSizeBytes * 11);
    const error = await openError(
      buildEpub({ spine: [{ path: "a.xhtml", xhtml: chapterXhtml(`<p>${bomb}</p>`) }] })
    );
    expect(getAppErrorCode(error)).toBe("CONTENT_TOO_LARGE");
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
    ["isn't a ZIP", Buffer.from("not a zip")],
    ["has no package document", buildZip({ mimetype: "application/epub+zip" })],
    ["has an empty spine", buildEpub({ spine: [] })],
  ])("rejects a file that %s", async (_label, file) => {
    await expect(openEpub(file)).rejects.toThrow();
  });
});

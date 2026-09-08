/**
 * Unit tests for rendering a Notion block tree to HTML.
 */

import { describe, it, expect } from "vitest";
import type { NotionBlock, NotionBlockMap } from "../../src/server/notion/api";
import { proxiedImageUrl, renderNotionPage } from "../../src/server/notion/render";

const PAGE_ID = "37bb1284-725b-81c6-9167-c4b2a67c26e1";
const BASE_URL = new URL(
  `https://handbook.sparai.org/How-to-succeed-in-SPAR-${PAGE_ID.replace(/-/g, "")}`
);

let counter = 0;
function block(
  type: string,
  properties: Record<string, unknown> = {},
  extra: Partial<NotionBlock> = {}
): NotionBlock {
  counter += 1;
  return {
    id: `00000000-0000-0000-0000-${String(counter).padStart(12, "0")}`,
    type,
    properties,
    ...extra,
  };
}

function text(content: string, decorations?: unknown[]): unknown[] {
  return decorations ? [[content, decorations]] : [[content]];
}

/** Build a page whose body is `children`, in order, plus any extra blocks. */
function page(children: NotionBlock[], extra: NotionBlock[] = [], title = "Test page") {
  const root: NotionBlock = {
    id: PAGE_ID,
    type: "page",
    properties: { title: text(title) },
    content: children.map((c) => c.id),
  };
  const map: NotionBlockMap = new Map([[PAGE_ID, root]]);
  for (const b of [...children, ...extra]) map.set(b.id, b);
  return map;
}

function render(children: NotionBlock[], extra: NotionBlock[] = []): string {
  const rendered = renderNotionPage(page(children, extra), PAGE_ID, BASE_URL);
  expect(rendered).not.toBeNull();
  return rendered!.html;
}

describe("renderNotionPage", () => {
  it("returns the page title and null for a page the reader can't see", () => {
    const rendered = renderNotionPage(page([]), PAGE_ID, BASE_URL);
    expect(rendered).toEqual({ html: "", title: "Test page" });
    expect(renderNotionPage(new Map(), PAGE_ID, BASE_URL)).toBeNull();
  });

  it("returns a null title for an untitled page", () => {
    const map = page([], [], "");
    expect(renderNotionPage(map, PAGE_ID, BASE_URL)?.title).toBeNull();
  });

  it("renders paragraphs and headings, skipping empty spacer paragraphs", () => {
    const html = render([
      block("header", { title: text("Section") }),
      block("text", { title: text("Body") }),
      block("text"),
      block("sub_header", { title: text("Sub") }),
      block("sub_sub_header", { title: text("Sub sub") }),
      block("divider"),
    ]);
    expect(html).toBe("<h1>Section</h1><p>Body</p><h2>Sub</h2><h3>Sub sub</h3><hr>");
  });

  it("applies inline decorations in order (first innermost), with the link outermost", () => {
    const html = render([
      block("text", {
        title: [
          ["plain "],
          ["bold", [["b"]]],
          [" ", []],
          ["italic strike", [["i"], ["s"]]],
          [" ", []],
          ["under", [["_"]]],
          [" ", []],
          ["code", [["c"]]],
          [" ", []],
          ["linked bold", [["b"], ["a", "https://example.com/x?a=1&b=2"]]],
          [" colored", [["h", "red"]]],
        ],
      }),
    ]);
    expect(html).toBe(
      "<p>plain <strong>bold</strong> <del><em>italic strike</em></del> <u>under</u> <code>code</code> " +
        '<a href="https://example.com/x?a=1&amp;b=2"><strong>linked bold</strong></a> colored</p>'
    );
  });

  it("escapes text and attributes so page content can't inject markup", () => {
    const html = render([
      block("text", {
        title: [
          ['<script>alert(1)</script> & "quotes"', [["a", 'https://example.com/"onmouseover="x']]],
        ],
      }),
    ]);
    expect(html).toBe(
      '<p><a href="https://example.com/%22onmouseover=%22x">&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;</a></p>'
    );
  });

  it("drops links with unsafe schemes but keeps their text", () => {
    const html = render([block("text", { title: [["click", [["a", "javascript:alert(1)"]]]] })]);
    expect(html).toBe("<p>click</p>");
  });

  it("resolves relative links against the page's origin", () => {
    const html = render([
      block("text", {
        title: [["sibling", [["a", "/Other-Page-0123456789abcdef0123456789abcdef"]]]],
      }),
    ]);
    expect(html).toBe(
      '<p><a href="https://handbook.sparai.org/Other-Page-0123456789abcdef0123456789abcdef">sibling</a></p>'
    );
  });

  it("turns newlines inside a paragraph into <br>", () => {
    expect(render([block("text", { title: text("line one\nline two") })])).toBe(
      "<p>line one<br>line two</p>"
    );
  });

  it("groups consecutive list items and nests children inside the item", () => {
    const nested = block("bulleted_list", { title: text("nested") });
    const html = render(
      [
        block("bulleted_list", { title: text("one") }, { content: [nested.id] }),
        block("bulleted_list", { title: text("two") }),
        block("numbered_list", { title: text("first") }),
        block("numbered_list", { title: text("second") }),
        block("text", { title: text("after") }),
        block("bulleted_list", { title: text("again") }),
      ],
      [nested]
    );
    expect(html).toBe(
      "<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>" +
        "<ol><li>first</li><li>second</li></ol>" +
        "<p>after</p>" +
        "<ul><li>again</li></ul>"
    );
  });

  it("renders to-dos as disabled task-list checkboxes", () => {
    const html = render([
      block("to_do", { title: text("done"), checked: text("Yes") }),
      block("to_do", { title: text("open"), checked: text("No") }),
    ]);
    expect(html).toBe(
      '<ul><li><input type="checkbox" disabled checked> done</li><li><input type="checkbox" disabled> open</li></ul>'
    );
  });

  it("renders quotes, callouts with an emoji icon, and toggles", () => {
    const inner = block("text", { title: text("inside") });
    const html = render(
      [
        block("quote", { title: text("quoted") }),
        block(
          "callout",
          { title: text("note") },
          { format: { page_icon: "🚀", block_color: "yellow_background" }, content: [inner.id] }
        ),
        block(
          "callout",
          { title: text("image icon") },
          { format: { page_icon: "https://x/y.png" } }
        ),
        block("toggle", { title: text("more") }, { content: [inner.id] }),
      ],
      [inner]
    );
    expect(html).toBe(
      "<blockquote><p>quoted</p></blockquote>" +
        "<blockquote><p>🚀 note</p><p>inside</p></blockquote>" +
        "<blockquote><p>image icon</p></blockquote>" +
        "<details><summary>more</summary><p>inside</p></details>"
    );
  });

  it("renders code blocks with a language class, escaped, ignoring decorations", () => {
    const html = render([
      block("code", {
        title: [["const a = <b>1</b>;\n", [["b"]]], ["return a;"]],
        language: text("TypeScript"),
      }),
      block("code", { title: text("x"), language: text("Plain Text"), caption: text("cap") }),
    ]);
    expect(html).toBe(
      '<pre><code class="language-typescript">const a = &lt;b&gt;1&lt;/b&gt;;\nreturn a;</code></pre>' +
        '<figure><pre><code class="language-plaintext">x</code></pre><figcaption>cap</figcaption></figure>'
    );
  });

  it("renders equations as code", () => {
    expect(render([block("equation", { title: text("E = mc^2") })])).toBe(
      "<p><code>E = mc^2</code></p>"
    );
    expect(render([block("text", { title: [["⁍", [["e", "\\alpha < 1"]]]] })])).toBe(
      "<p><code>\\alpha &lt; 1</code></p>"
    );
  });

  it("renders images through Notion's proxy with the caption as alt and figcaption", () => {
    const img = block(
      "image",
      {
        source: text("https://prod-files-secure.s3.us-west-2.amazonaws.com/abc/def/photo.png"),
        caption: text("A photo"),
      },
      { space_id: "space-1" }
    );
    const html = render([img]);
    const expectedSrc =
      "https://www.notion.so/image/" +
      encodeURIComponent("https://prod-files-secure.s3.us-west-2.amazonaws.com/abc/def/photo.png") +
      `?table=block&amp;id=${img.id}&amp;spaceId=space-1&amp;cache=v2`;
    expect(html).toBe(
      `<figure><img src="${expectedSrc}" alt="A photo"><figcaption>A photo</figcaption></figure>`
    );
  });

  it("renders a captionless image from format.display_source", () => {
    const img = block("image", {}, { format: { display_source: "https://example.com/a.png" } });
    expect(render([img])).toBe(
      `<figure><img src="https://www.notion.so/image/${encodeURIComponent("https://example.com/a.png")}?table=block&amp;id=${img.id}&amp;cache=v2" alt=""></figure>`
    );
  });

  it("skips images without a usable source", () => {
    expect(
      render([block("image"), block("image", { source: text("data:image/png;base64,AAAA") })])
    ).toBe("");
  });

  it("renders bookmarks, embeds, and files as links", () => {
    const html = render([
      block("bookmark", {
        link: text("https://example.com/article"),
        title: text("An article"),
        description: text("What it says"),
      }),
      block("bookmark", { link: text("https://example.com/bare") }),
      block("video", { source: text("https://www.youtube.com/watch?v=abc") }),
      block("file", { source: text("https://example.com/f.pdf"), title: text("f.pdf") }),
      block("external_object_instance", {}, { format: { uri: "https://github.com/x/y" } }),
    ]);
    expect(html).toBe(
      '<p><a href="https://example.com/article">An article</a><br>What it says</p>' +
        '<p><a href="https://example.com/bare">https://example.com/bare</a></p>' +
        '<p><a href="https://www.youtube.com/watch?v=abc">https://www.youtube.com/watch?v=abc</a></p>' +
        '<p><a href="https://example.com/f.pdf">f.pdf</a></p>' +
        '<p><a href="https://github.com/x/y">https://github.com/x/y</a></p>'
    );
  });

  it("renders child pages and aliases as links on the page's own origin", () => {
    const child = block("page", { title: text("Child") }, { format: { page_icon: "📄" } });
    const bareId = child.id.replace(/-/g, "");
    const html = render([
      child,
      block("alias", {}, { format: { alias_pointer: { id: child.id } } }),
    ]);
    expect(html).toBe(
      `<p><a href="https://handbook.sparai.org/${bareId}">📄 Child</a></p>`.repeat(2)
    );
  });

  it("renders page and date mentions, and drops user mentions", () => {
    const other = block("page", { title: text("Other page") });
    const html = render(
      [
        block("text", {
          title: [
            ["See "],
            ["‣", [["p", other.id]]],
            [" on "],
            [
              "‣",
              [["d", { start_date: "2026-09-08", start_time: "10:00", end_date: "2026-09-09" }]],
            ],
            [" by "],
            ["‣", [["u", "user-id"]]],
            ["."],
          ],
        }),
      ],
      [other]
    );
    expect(html).toBe(
      `<p>See <a href="https://handbook.sparai.org/${other.id.replace(/-/g, "")}">Other page</a> on 2026-09-08 10:00 → 2026-09-09 by .</p>`
    );
  });

  it("flattens columns and synced blocks, following synced-block references", () => {
    const a = block("text", { title: text("left") });
    const b = block("text", { title: text("right") });
    const colA = block("column", {}, { content: [a.id] });
    const colB = block("column", {}, { content: [b.id] });
    const synced = block("text", { title: text("synced") });
    const container = block("transclusion_container", {}, { content: [synced.id] });
    const reference = block(
      "transclusion_reference",
      {},
      { format: { transclusion_reference_pointer: { id: container.id, table: "block" } } }
    );
    const html = render(
      [block("column_list", {}, { content: [colA.id, colB.id] }), container, reference],
      [a, b, colA, colB, synced]
    );
    expect(html).toBe("<p>left</p><p>right</p><p>synced</p><p>synced</p>");
  });

  it("renders simple tables, with a header row when declared", () => {
    const row1 = block("table_row", { c1: text("Name"), c2: text("Role") });
    const row2 = block("table_row", { c1: text("Ada"), c2: text("Mentor") });
    const table = block(
      "table",
      {},
      {
        content: [row1.id, row2.id],
        format: { table_block_column_order: ["c2", "c1"], table_block_column_header: true },
      }
    );
    expect(render([table], [row1, row2])).toBe(
      "<table><thead><tr><th>Role</th><th>Name</th></tr></thead><tbody><tr><td>Mentor</td><td>Ada</td></tr></tbody></table>"
    );
  });

  it("skips databases, tables of contents and breadcrumbs", () => {
    expect(
      render([block("collection_view"), block("table_of_contents"), block("breadcrumb")])
    ).toBe("");
  });

  it("keeps the text of unknown block types", () => {
    expect(render([block("future_block", { title: text("still here") })])).toBe(
      "<p>still here</p>"
    );
  });

  it("ignores children the reader can't see and survives reference cycles", () => {
    const loop = block("text", { title: text("loop") });
    loop.content = [loop.id, "missing-block-id"];
    expect(render([loop])).toBe("<p>loop</p>");
  });

  it("does not recurse into a child page that links back to the page itself", () => {
    const callout = block("callout", { title: text("Links") }, { content: [PAGE_ID] });
    const bareId = PAGE_ID.replace(/-/g, "");
    expect(render([callout])).toBe(
      `<blockquote><p>Links</p><p><a href="https://handbook.sparai.org/${bareId}">Test page</a></p></blockquote>`
    );
  });
});

describe("proxiedImageUrl", () => {
  const owner: NotionBlock = { id: "block-1", type: "image" };

  it("proxies S3 and external URLs, keying on the owning block", () => {
    expect(proxiedImageUrl("https://example.com/a.png", owner)).toBe(
      `https://www.notion.so/image/${encodeURIComponent("https://example.com/a.png")}?table=block&id=block-1&cache=v2`
    );
  });

  it("prefixes Notion's own static images", () => {
    expect(proxiedImageUrl("/images/page-cover/woodcuts_1.jpg", owner)).toBe(
      `https://www.notion.so/image/${encodeURIComponent("https://www.notion.so/images/page-cover/woodcuts_1.jpg")}?table=block&id=block-1&cache=v2`
    );
  });

  it("does not double-proxy an already proxied URL", () => {
    const already = `https://www.notion.so/image/${encodeURIComponent("https://example.com/a.png")}?table=block&id=old`;
    expect(proxiedImageUrl(already, owner)).toBe(
      `https://www.notion.so/image/${encodeURIComponent("https://example.com/a.png")}?table=block&id=block-1&cache=v2`
    );
  });

  it("refuses data URLs", () => {
    expect(proxiedImageUrl("data:image/png;base64,AAAA", owner)).toBeNull();
  });
});

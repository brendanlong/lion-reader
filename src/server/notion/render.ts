import { escapeHtml } from "@/server/http/html";
import type { NotionBlock, NotionBlockMap } from "./api";

/**
 * Renders a Notion block tree (as loaded by `fetchNotionPageBlocks`) to a bare
 * HTML fragment in the vocabulary the entry sanitizer keeps. Pure: no I/O.
 *
 * Notion rich text is an array of segments `[text, decorations?]`, where each
 * decoration is `[kind, ...args]`: `b`old, `i`talic, `s`trike, `_` underline,
 * `c`ode, `a` link (href), `e` inline equation (TeX), `h` color (ignored), and
 * mentions on the placeholder text `‣` — `p` page, `d` date, `u` user.
 */

type Decoration = [string, ...unknown[]];
type RichTextSegment = [string, Decoration[]?];

export interface RenderedNotionPage {
  html: string;
  title: string | null;
}

interface RenderContext {
  blocks: NotionBlockMap;
  /** Page URL the article was requested at; sibling pages link within its origin. */
  baseUrl: URL;
  /** Blocks whose children are being rendered, to break reference cycles. */
  rendering: Set<string>;
}

const MAX_DEPTH = 64;

const LIST_TAGS: Record<string, "ul" | "ol"> = {
  bulleted_list: "ul",
  numbered_list: "ol",
  to_do: "ul",
};

/** Blocks whose content is a link to an external resource we can't inline. */
const LINK_BLOCK_TYPES = new Set([
  "embed",
  "video",
  "audio",
  "pdf",
  "file",
  "tweet",
  "gist",
  "maps",
  "figma",
  "codepen",
  "drive",
  "excalidraw",
  "replit",
  "typeform",
  "miro",
  "whimsical",
  "loom",
]);

/** Layout-only wrappers: render children in order, no markup of their own. */
const TRANSPARENT_TYPES = new Set(["column_list", "column", "transclusion_container"]);

// ============================================================================
// Rich text
// ============================================================================

function isDecoration(value: unknown): value is Decoration {
  return Array.isArray(value) && typeof value[0] === "string";
}

function asRichText(value: unknown): RichTextSegment[] {
  if (!Array.isArray(value)) return [];
  const segments: RichTextSegment[] = [];
  for (const segment of value) {
    if (!Array.isArray(segment) || typeof segment[0] !== "string") continue;
    const decorations = Array.isArray(segment[1]) ? segment[1].filter(isDecoration) : [];
    segments.push([segment[0], decorations]);
  }
  return segments;
}

function property(block: NotionBlock, name: string): RichTextSegment[] {
  return asRichText(block.properties?.[name]);
}

function formatDateMention(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const date = value as Record<string, unknown>;
  const part = (key: string) => (typeof date[key] === "string" ? (date[key] as string) : null);
  const start = [part("start_date"), part("start_time")].filter(Boolean).join(" ");
  const end = [part("end_date"), part("end_time")].filter(Boolean).join(" ");
  return end ? `${start} → ${end}` : start;
}

function pageTitle(id: string, ctx: RenderContext): string {
  const page = ctx.blocks.get(id);
  const title = page ? plainText(property(page, "title")) : "";
  return title || "Untitled";
}

function pageHref(id: string, ctx: RenderContext): string {
  return new URL(`/${id.replace(/-/g, "")}`, ctx.baseUrl).href;
}

/**
 * Resolve a link target against the page and keep only http(s)/mailto. The
 * sanitizer re-checks schemes on read; this keeps the stored HTML clean too.
 */
function safeHref(href: string, ctx: RenderContext): string | null {
  try {
    const resolved = new URL(href, ctx.baseUrl);
    if (resolved.protocol === "http:" || resolved.protocol === "https:") return resolved.href;
    if (resolved.protocol === "mailto:") return resolved.href;
    return null;
  } catch {
    return null;
  }
}

function segmentPlainText(segment: RichTextSegment): string {
  const [text, decorations = []] = segment;
  if (text === "‣") {
    for (const decoration of decorations) {
      if (decoration[0] === "d") return formatDateMention(decoration[1]);
    }
    return "";
  }
  for (const decoration of decorations) {
    if (decoration[0] === "e" && typeof decoration[1] === "string") return decoration[1];
  }
  return text;
}

function plainText(richText: RichTextSegment[]): string {
  return richText.map(segmentPlainText).join("").trim();
}

function renderMention(decorations: Decoration[], ctx: RenderContext): string {
  for (const decoration of decorations) {
    switch (decoration[0]) {
      case "p":
        if (typeof decoration[1] === "string") {
          const id = decoration[1];
          return `<a href="${escapeHtml(pageHref(id, ctx))}">${escapeHtml(pageTitle(id, ctx))}</a>`;
        }
        break;
      case "d":
        return escapeHtml(formatDateMention(decoration[1]));
    }
  }
  return "";
}

function renderSegment(segment: RichTextSegment, ctx: RenderContext): string {
  const [text, decorations = []] = segment;
  if (text === "‣") return renderMention(decorations, ctx);

  let html = escapeHtml(text).replace(/\n/g, "<br>");
  let href: string | null = null;
  for (const decoration of decorations) {
    switch (decoration[0]) {
      case "b":
        html = `<strong>${html}</strong>`;
        break;
      case "i":
        html = `<em>${html}</em>`;
        break;
      case "s":
        html = `<del>${html}</del>`;
        break;
      case "_":
        html = `<u>${html}</u>`;
        break;
      case "c":
        html = `<code>${html}</code>`;
        break;
      case "e":
        if (typeof decoration[1] === "string") html = `<code>${escapeHtml(decoration[1])}</code>`;
        break;
      case "a":
        if (typeof decoration[1] === "string") href = safeHref(decoration[1], ctx);
        break;
    }
  }
  return href ? `<a href="${escapeHtml(href)}">${html}</a>` : html;
}

function renderRichText(richText: RichTextSegment[], ctx: RenderContext): string {
  return richText.map((segment) => renderSegment(segment, ctx)).join("");
}

// ============================================================================
// Blocks
// ============================================================================

function stringField(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pointerId(record: Record<string, unknown> | undefined, key: string): string | null {
  const pointer = record?.[key];
  if (typeof pointer !== "object" || pointer === null) return null;
  const id = (pointer as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

/** An emoji page icon; image icons (URLs, `attachment:` refs) are skipped. */
function emojiIcon(block: NotionBlock): string | null {
  const icon = stringField(block.format, "page_icon");
  if (!icon || icon.includes("/") || icon.includes(":")) return null;
  return icon;
}

/**
 * Route an image through Notion's image proxy. Uploaded files are served from
 * S3 with signed, expiring URLs; the proxy issues a fresh signature per request
 * when given the owning block, so the stored URL keeps working.
 */
export function proxiedImageUrl(source: string, block: NotionBlock): string | null {
  if (source.startsWith("data:")) return null;
  const absolute = source.startsWith("/images/") ? `https://www.notion.so${source}` : source;
  const proxied = absolute.startsWith("https://www.notion.so/image/")
    ? new URL(absolute)
    : new URL(`https://www.notion.so/image/${encodeURIComponent(absolute)}`);
  proxied.searchParams.set("table", "block");
  proxied.searchParams.set("id", block.id);
  if (block.space_id) proxied.searchParams.set("spaceId", block.space_id);
  proxied.searchParams.set("cache", "v2");
  return proxied.href;
}

function blockSource(block: NotionBlock): string | null {
  return plainText(property(block, "source")) || stringField(block.format, "display_source");
}

function renderChildren(block: NotionBlock, ctx: RenderContext, depth: number): string {
  if (!block.content?.length || ctx.rendering.has(block.id) || depth >= MAX_DEPTH) return "";
  ctx.rendering.add(block.id);
  try {
    return renderBlocks(block.content, ctx, depth + 1);
  } finally {
    ctx.rendering.delete(block.id);
  }
}

function renderPageLink(id: string, ctx: RenderContext): string {
  const page = ctx.blocks.get(id);
  const icon = page ? emojiIcon(page) : null;
  const label = `${icon ? `${icon} ` : ""}${pageTitle(id, ctx)}`;
  return `<p><a href="${escapeHtml(pageHref(id, ctx))}">${escapeHtml(label)}</a></p>`;
}

function renderLink(href: string | null, label: string, ctx: RenderContext): string {
  const safe = href ? safeHref(href, ctx) : null;
  const text = escapeHtml(label || safe || "");
  if (!text) return "";
  return safe ? `<p><a href="${escapeHtml(safe)}">${text}</a></p>` : `<p>${text}</p>`;
}

function renderImage(block: NotionBlock, ctx: RenderContext): string {
  const source = blockSource(block);
  const src = source ? proxiedImageUrl(source, block) : null;
  if (!src) return "";
  const caption = property(block, "caption");
  const alt = escapeHtml(plainText(caption));
  const img = `<img src="${escapeHtml(src)}" alt="${alt}">`;
  return caption.length
    ? `<figure>${img}<figcaption>${renderRichText(caption, ctx)}</figcaption></figure>`
    : `<figure>${img}</figure>`;
}

function renderCode(block: NotionBlock, ctx: RenderContext): string {
  const language = plainText(property(block, "language"))
    .toLowerCase()
    .replace(/[^a-z0-9+#-]/g, "");
  const classAttr = language ? ` class="language-${language}"` : "";
  const code = property(block, "title")
    .map(([text]) => escapeHtml(text))
    .join("");
  const pre = `<pre><code${classAttr}>${code}</code></pre>`;
  const caption = property(block, "caption");
  return caption.length
    ? `<figure>${pre}<figcaption>${renderRichText(caption, ctx)}</figcaption></figure>`
    : pre;
}

function renderTable(block: NotionBlock, ctx: RenderContext): string {
  const rows = (block.content ?? [])
    .map((id) => ctx.blocks.get(id))
    .filter((row): row is NotionBlock => row?.type === "table_row");
  if (rows.length === 0) return "";

  const orderField = block.format?.table_block_column_order;
  const columns =
    Array.isArray(orderField) && orderField.every((c) => typeof c === "string")
      ? (orderField as string[])
      : Object.keys(rows[0]!.properties ?? {});
  const hasHeader = block.format?.table_block_column_header === true;

  const renderRow = (row: NotionBlock, cell: "th" | "td") =>
    `<tr>${columns
      .map((column) => `<${cell}>${renderRichText(property(row, column), ctx)}</${cell}>`)
      .join("")}</tr>`;

  const [first, ...rest] = rows;
  const head = hasHeader ? `<thead>${renderRow(first!, "th")}</thead>` : "";
  const bodyRows = hasHeader ? rest : rows;
  return `<table>${head}<tbody>${bodyRows.map((row) => renderRow(row, "td")).join("")}</tbody></table>`;
}

function renderListItem(block: NotionBlock, ctx: RenderContext, depth: number): string {
  const text = renderRichText(property(block, "title"), ctx);
  const children = renderChildren(block, ctx, depth);
  if (block.type === "to_do") {
    const checked = plainText(property(block, "checked")) === "Yes";
    return `<li><input type="checkbox" disabled${checked ? " checked" : ""}> ${text}${children}</li>`;
  }
  return `<li>${text}${children}</li>`;
}

function renderBlock(block: NotionBlock, ctx: RenderContext, depth: number): string {
  const title = () => renderRichText(property(block, "title"), ctx);
  const children = () => renderChildren(block, ctx, depth);

  switch (block.type) {
    case "text": {
      const text = title();
      return `${text ? `<p>${text}</p>` : ""}${children()}`;
    }
    case "header":
      return `<h1>${title()}</h1>${children()}`;
    case "sub_header":
      return `<h2>${title()}</h2>${children()}`;
    case "sub_sub_header":
      return `<h3>${title()}</h3>${children()}`;
    case "quote":
      return `<blockquote><p>${title()}</p>${children()}</blockquote>`;
    case "callout": {
      const icon = emojiIcon(block);
      const text = `${icon ? `${escapeHtml(icon)} ` : ""}${title()}`;
      return `<blockquote><p>${text}</p>${children()}</blockquote>`;
    }
    case "toggle":
      return `<details><summary>${title()}</summary>${children()}</details>`;
    case "divider":
      return "<hr>";
    case "code":
      return renderCode(block, ctx);
    case "equation": {
      const tex = plainText(property(block, "title"));
      return tex ? `<p><code>${escapeHtml(tex)}</code></p>` : "";
    }
    case "image":
      return renderImage(block, ctx);
    case "bookmark": {
      const link = plainText(property(block, "link"));
      const description = renderRichText(property(block, "description"), ctx);
      const anchor = renderLink(link, plainText(property(block, "title")), ctx);
      if (!anchor || !description) return anchor;
      return anchor.replace(/<\/p>$/, `<br>${description}</p>`);
    }
    case "page":
    case "collection_view_page":
      return renderPageLink(block.id, ctx);
    case "alias": {
      const target = pointerId(block.format, "alias_pointer");
      return target ? renderPageLink(target, ctx) : "";
    }
    case "transclusion_reference": {
      const target = pointerId(block.format, "transclusion_reference_pointer");
      const source = target ? ctx.blocks.get(target) : undefined;
      return source ? renderChildren(source, ctx, depth) : "";
    }
    case "external_object_instance": {
      const uri = stringField(block.format, "uri");
      return uri ? renderLink(uri, uri, ctx) : "";
    }
    case "table":
      return renderTable(block, ctx);
    case "table_row":
    case "collection_view":
    case "table_of_contents":
    case "breadcrumb":
      return "";
    default:
      if (block.type && TRANSPARENT_TYPES.has(block.type)) return children();
      if (block.type && LINK_BLOCK_TYPES.has(block.type)) {
        return renderLink(blockSource(block), plainText(property(block, "title")), ctx);
      }
      // Unknown block: keep any text it carries rather than lose it.
      const text = title();
      return `${text ? `<p>${text}</p>` : ""}${children()}`;
  }
}

/**
 * Render sibling blocks in order. Consecutive list items of one kind become a
 * single `<ul>`/`<ol>`; Notion stores each item as its own block.
 */
function renderBlocks(ids: string[], ctx: RenderContext, depth: number): string {
  // A block already being rendered further up is a cycle; a page is exempt
  // because it renders as a link, never its children.
  const blocks = ids
    .map((id) => ctx.blocks.get(id))
    .filter(
      (b): b is NotionBlock => b !== undefined && (b.type === "page" || !ctx.rendering.has(b.id))
    );
  let html = "";
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i]!;
    const listTag = block.type ? LIST_TAGS[block.type] : undefined;
    if (!listTag) {
      html += renderBlock(block, ctx, depth);
      i++;
      continue;
    }
    let items = "";
    while (i < blocks.length && blocks[i]!.type === block.type) {
      items += renderListItem(blocks[i]!, ctx, depth);
      i++;
    }
    html += `<${listTag}>${items}</${listTag}>`;
  }
  return html;
}

/**
 * Render the page `pageId` from a loaded block map. Returns null when the page
 * block itself isn't in the map — the endpoint's way of saying the page isn't
 * published (or doesn't exist).
 */
export function renderNotionPage(
  blocks: NotionBlockMap,
  pageId: string,
  baseUrl: URL
): RenderedNotionPage | null {
  const page = blocks.get(pageId);
  if (!page || page.type !== "page") return null;

  const ctx: RenderContext = { blocks, baseUrl, rendering: new Set([pageId]) };
  return {
    html: renderBlocks(page.content ?? [], ctx, 0),
    title: plainText(property(page, "title")) || null,
  };
}

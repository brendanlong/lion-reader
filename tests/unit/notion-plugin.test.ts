/**
 * Unit tests for Notion URL parsing, shell detection, and plugin matching.
 */

import { describe, it, expect } from "vitest";
import {
  extractNotionPageId,
  extractNotionPageIdFromShell,
  isNotionShell,
  notionPlugin,
} from "../../src/server/plugins/notion";
import { formatNotionId } from "../../src/server/notion/page-id";

const PAGE_ID = "37bb1284-725b-81c6-9167-c4b2a67c26e1";
const BARE_ID = "37bb1284725b81c69167c4b2a67c26e1";

/**
 * The head of the shell Notion serves for a published page, trimmed but
 * structurally faithful: the root element's class, the marketing <meta> tags
 * that describe Notion rather than the page, and the async boot pushes,
 * including the one that names the page. Taken from handbook.sparai.org.
 */
const NOTION_SHELL = `<!doctype html><html class="notion-html" data-notion-html="web" data-notion-version="23.13.20260908.1512"><head lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Notion</title><meta property="og:site_name" content="Notion"><meta property="og:title" content="Notion | Where teams and agents work together"></head><body><script>window.__notion_boot_data=null;__notion_html_async.push("bootData",null)</script><script>__notion_html_async.push("requiredRedirectMetadata",{"pageId":"${PAGE_ID}","requiresRedirect":false})</script><script>__notion_html_async.push("statsigResults",null)</script><p></p></body></html>`;

/** A site root: same shell, but nothing names a page. */
const NOTION_ROOT_SHELL = NOTION_SHELL.replace(
  /<script>__notion_html_async\.push\("requiredRedirectMetadata".*?<\/script>/,
  ""
);

describe("formatNotionId", () => {
  it("dashes a bare 32-hex id", () => {
    expect(formatNotionId(BARE_ID)).toBe(PAGE_ID);
  });

  it("lowercases and keeps an already-dashed id", () => {
    expect(formatNotionId(PAGE_ID.toUpperCase())).toBe(PAGE_ID);
  });

  it("rejects anything else", () => {
    expect(formatNotionId("not-an-id")).toBeNull();
    expect(formatNotionId(BARE_ID.slice(1))).toBeNull();
    expect(formatNotionId(`${BARE_ID}0`)).toBeNull();
  });
});

describe("extractNotionPageId", () => {
  it("reads the id off a slugged page URL on a custom domain", () => {
    const url = new URL(`https://handbook.sparai.org/How-to-succeed-in-SPAR-${BARE_ID}`);
    expect(extractNotionPageId(url)).toBe(PAGE_ID);
  });

  it("reads a bare-id path, with or without a trailing slash", () => {
    expect(extractNotionPageId(new URL(`https://www.notion.so/${BARE_ID}`))).toBe(PAGE_ID);
    expect(extractNotionPageId(new URL(`https://acme.notion.site/${BARE_ID}/`))).toBe(PAGE_ID);
  });

  it("reads a workspace-prefixed notion.so URL", () => {
    const url = new URL(`https://www.notion.so/acme/Team-Handbook-${BARE_ID}?pvs=4`);
    expect(extractNotionPageId(url)).toBe(PAGE_ID);
  });

  it("prefers the peeked page in ?p= over the path", () => {
    const peeked = "0123456789abcdef0123456789abcdef";
    const url = new URL(`https://www.notion.so/Parent-${BARE_ID}?p=${peeked}&pm=s`);
    expect(extractNotionPageId(url)).toBe("01234567-89ab-cdef-0123-456789abcdef");
  });

  it("ignores a malformed ?p= and falls back to the path", () => {
    const url = new URL(`https://www.notion.so/Parent-${BARE_ID}?p=nope`);
    expect(extractNotionPageId(url)).toBe(PAGE_ID);
  });

  it("returns null when the URL names no page", () => {
    expect(extractNotionPageId(new URL("https://acme.notion.site/"))).toBeNull();
    expect(extractNotionPageId(new URL("https://www.notion.so/product"))).toBeNull();
    expect(extractNotionPageId(new URL("https://www.notion.com/blog/some-post"))).toBeNull();
  });

  it("does not take the tail of a longer hex string for an id", () => {
    expect(extractNotionPageId(new URL(`https://example.com/abc${BARE_ID}`))).toBeNull();
  });
});

describe("Notion shell detection", () => {
  it("recognizes the shell by its root element", () => {
    expect(isNotionShell(NOTION_SHELL)).toBe(true);
    expect(isNotionShell(NOTION_ROOT_SHELL)).toBe(true);
  });

  it("does not recognize ordinary pages, even ones that mention Notion", () => {
    expect(isNotionShell("<!doctype html><html><head><title>Notion</title></head></html>")).toBe(
      false
    );
    expect(isNotionShell('<html class="notion-html-not"><body>notion-html</body></html>')).toBe(
      false
    );
    expect(isNotionShell("")).toBe(false);
  });

  it("inspects only the root element, not a later <html in the body", () => {
    expect(
      isNotionShell('<html><body>&lt;html class="notion-html"&gt;<html class="notion-html"></body>')
    ).toBe(false);
    expect(isNotionShell('<html lang="en" class="dark notion-html"><head></head></html>')).toBe(
      true
    );
  });

  it("stays linear on a document made of repeated <html fragments", () => {
    const hostile = "<html".repeat(13000);
    const started = performance.now();
    expect(isNotionShell(hostile)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("reads the served page id from the shell", () => {
    expect(extractNotionPageIdFromShell(NOTION_SHELL)).toBe(PAGE_ID);
  });

  it("finds no page id in a site-root shell", () => {
    expect(extractNotionPageIdFromShell(NOTION_ROOT_SHELL)).toBeNull();
  });

  it("only scans the head of the document", () => {
    const late = `<html><body>${"x".repeat(70000)}<script>{"pageId":"${PAGE_ID}"}</script>`;
    expect(extractNotionPageIdFromShell(late)).toBeNull();
  });
});

describe("notionPlugin", () => {
  it("matches page URLs and declines URLs without a page id", () => {
    expect(notionPlugin.matchUrl(new URL(`https://www.notion.so/Page-${BARE_ID}`))).toBe(true);
    expect(notionPlugin.matchUrl(new URL("https://www.notion.so/pricing"))).toBe(false);
  });

  it("declines a fetched page that is not the Notion shell without any network call", async () => {
    const content = await notionPlugin.capabilities.savedArticle!.fetchContentFromPage!({
      html: "<html><body><article>Real article</article></body></html>",
      url: new URL("https://example.com/post"),
    });
    expect(content).toBeNull();
  });

  it("declines a site-root shell that names no page", async () => {
    const content = await notionPlugin.capabilities.savedArticle!.fetchContentFromPage!({
      html: NOTION_ROOT_SHELL,
      url: new URL("https://handbook.sparai.org/"),
    });
    expect(content).toBeNull();
  });

  it("skips Readability: the rendered fragment is the article", () => {
    expect(notionPlugin.capabilities.savedArticle!.skipReadability).toBe(true);
  });
});

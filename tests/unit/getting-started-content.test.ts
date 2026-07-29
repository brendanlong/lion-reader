/**
 * Guards on the Getting Started article's content (issue #1397).
 *
 * The article is the first thing a new user reads, and it is almost entirely
 * links into the app. A route that gets renamed would leave dead links in every
 * future user's inbox with nothing to catch it, so the in-app links are checked
 * against the routes that actually exist in src/app.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";

import {
  GETTING_STARTED_EXCERPT,
  GETTING_STARTED_MARKDOWN,
  GETTING_STARTED_TITLE,
} from "../../src/server/services/getting-started-content";
import { processMarkdown } from "../../src/server/markdown";
import { sanitizeEntryHtmlAsync } from "../../src/server/html/sanitize";

const APP_DIR = path.join(__dirname, "..", "..", "src", "app");

/**
 * Every routable pathname in src/app, derived from its page.tsx files: strip
 * the route-group segments `(spa)`, `(app)`, `(public)`, … and turn the rest
 * into a URL path. Dynamic segments (`[id]`) are left as-is; the article
 * doesn't link to any.
 */
function appRoutes(): Set<string> {
  const routes = new Set<string>();

  const walk = (dir: string, segments: string[]): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const isRouteGroup = entry.name.startsWith("(") && entry.name.endsWith(")");
        walk(path.join(dir, entry.name), isRouteGroup ? segments : [...segments, entry.name]);
      } else if (entry.name === "page.tsx") {
        routes.add(`/${segments.join("/")}`);
      }
    }
  };

  walk(APP_DIR, []);
  return routes;
}

/** `[label](target)` targets, in order. */
function markdownLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((m) => m[1]);
}

describe("Getting Started content", () => {
  it("only links to app routes that exist", () => {
    const routes = appRoutes();
    const internal = markdownLinkTargets(GETTING_STARTED_MARKDOWN).filter((t) => t.startsWith("/"));

    // Strip the query string — /demo/all?entry=welcome routes to /demo/all.
    const missing = internal.filter((target) => !routes.has(target.split("?")[0]));

    expect(missing).toEqual([]);
    // Guard against the regex silently matching nothing.
    expect(internal.length).toBeGreaterThan(5);
  });

  it("uses relative links for anything in-app", () => {
    // An absolute lionreader.com link would be wrong on a self-hosted instance.
    const absolute = markdownLinkTargets(GETTING_STARTED_MARKDOWN).filter((t) =>
      /^https?:\/\/(www\.)?lionreader\.com/i.test(t)
    );
    expect(absolute).toEqual([]);
  });

  it("has a title and an excerpt", () => {
    expect(GETTING_STARTED_TITLE.length).toBeGreaterThan(0);
    expect(GETTING_STARTED_EXCERPT.length).toBeGreaterThan(0);
    // The body's own first lines are a poor excerpt, so one is supplied; if it
    // ever grows past the saved-article clip it just gets truncated.
    expect(GETTING_STARTED_EXCERPT.length).toBeLessThanOrEqual(300);
  });

  it("starts with prose, not a heading that would become the title", () => {
    // processMarkdown promotes a leading H1 into the title, which would then
    // fight the explicit title we pass to uploadArticle.
    expect(GETTING_STARTED_MARKDOWN.startsWith("#")).toBe(false);
  });
});

describe("Getting Started rendering", () => {
  it("renders through the real pipeline with working links and no stray breaks", async () => {
    const rendered = await processMarkdown(GETTING_STARTED_MARKDOWN);
    const html = await sanitizeEntryHtmlAsync(rendered.html);

    // Our dialect turns a single newline into a <br>, so hard-wrapping the
    // source would show up as ragged line breaks mid-paragraph.
    expect(html).not.toContain("<br");

    // In-app links stay same-tab; external ones are given a safe new tab.
    expect(html).toContain('<a href="/subscribe">');
    expect(html).toContain('<a href="/settings/ai">');
    expect(html).toContain(
      '<a href="https://modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer">'
    );

    // No leading H1 to compete with the explicit title.
    expect(rendered.title).toBeNull();
  });
});

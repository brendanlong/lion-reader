/**
 * Guards on the Getting Started articles' content (issue #1397).
 *
 * The articles are the first thing a new user reads, and they are mostly
 * links into the app. A route or settings section that gets renamed would
 * leave dead links in every future user's collection with nothing to catch
 * it, so the in-app links are checked against the routes that actually exist
 * in src/app and the settings sections that carry each anchor.
 */

import * as fs from "fs";
import * as path from "path";
import { describe, it, expect } from "vitest";

import { GETTING_STARTED_ARTICLES } from "../../src/server/services/getting-started-content";
import { SETTINGS_SEARCH_INDEX } from "../../src/components/settings/settings-search";
import { processMarkdown } from "../../src/server/markdown";
import { sanitizeEntryHtmlAsync } from "../../src/server/html/sanitize";

const APP_DIR = path.join(__dirname, "..", "..", "src", "app");

/**
 * Every routable pathname in src/app, derived from its page.tsx files: strip
 * the route-group segments `(spa)`, `(app)`, `(public)`, … and turn the rest
 * into a URL path. Dynamic segments (`[id]`) are left as-is; the articles
 * don't link to any.
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

const linkTargets = GETTING_STARTED_ARTICLES.flatMap((article) =>
  [...article.markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((m) => m[1])
);
const internalTargets = linkTargets.filter((target) => target.startsWith("/"));

describe("Getting Started content", () => {
  it("only links to app routes that exist", () => {
    const routes = appRoutes();
    const missing = internalTargets.filter((target) => !routes.has(target.split(/[?#]/)[0]));

    expect(missing).toEqual([]);
    // Guard against the regex silently matching nothing.
    expect(internalTargets.length).toBeGreaterThan(GETTING_STARTED_ARTICLES.length);
  });

  it("only links to settings sections that are on the linked page", () => {
    const sections = new Set(SETTINGS_SEARCH_INDEX.map(({ page, id }) => `${page}#${id}`));
    const anchored = internalTargets.filter((target) => target.includes("#"));

    expect(anchored.filter((target) => !sections.has(target))).toEqual([]);
    expect(anchored.length).toBeGreaterThan(0);
  });

  it("uses relative links for anything in-app", () => {
    // An absolute lionreader.com link would be wrong on a self-hosted instance.
    const absolute = linkTargets.filter((t) => /^https?:\/\/(www\.)?lionreader\.com/i.test(t));
    expect(absolute).toEqual([]);
  });

  it("gives every article its own key", () => {
    const keys = GETTING_STARTED_ARTICLES.map((article) => article.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("Getting Started rendering", () => {
  it.each(GETTING_STARTED_ARTICLES)(
    "$key renders through the real pipeline with no stray breaks",
    async ({ markdown }) => {
      const rendered = await processMarkdown(markdown);
      const html = await sanitizeEntryHtmlAsync(rendered.html);

      // Our dialect turns a single newline into a <br>, so hard-wrapping the
      // source would show up as ragged line breaks mid-paragraph.
      expect(html).not.toContain("<br");
      // No leading H1 to compete with the explicit title.
      expect(rendered.title).toBeNull();
    }
  );

  it("keeps in-app links same-tab and opens external ones in a safe new tab", async () => {
    const mcp = GETTING_STARTED_ARTICLES.find((article) => article.key === "mcp")!;
    const html = await sanitizeEntryHtmlAsync((await processMarkdown(mcp.markdown)).html);

    expect(html).toContain('<a href="/settings/integrations#ai-integrations">');
    expect(html).toContain(
      '<a href="https://modelcontextprotocol.io/" target="_blank" rel="noopener noreferrer">'
    );
  });
});

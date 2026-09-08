/**
 * E2E tests for the public demo (issue #1524).
 *
 * The demo renders the app's own reader tree over an in-memory store, served
 * as statically-prerendered pages. These tests pin what that has to deliver:
 *
 * - the prerendered HTML already carries the article / list content (SEO and
 *   first paint — no skeleton swap), with crawlable entry links;
 * - hydration is clean: no console errors (hydration mismatches, React
 *   warnings) on the landing URL, on a tag-route article (prerendered as /all
 *   and re-derived from the real URL after hydration), and on a list page;
 * - the tree is live after hydration: opening, starring, marking read and
 *   searching all work through the real cache layer, with no `/api/trpc`
 *   traffic at all (every procedure resolves in-process);
 * - the URL plumbing: the old /demo/highlights URL redirects, and the internal
 *   rewrite target normalizes to the public `?entry=` form without closing
 *   and reopening the article.
 */

import { test, expect, type Page } from "@playwright/test";

/**
 * Collects every console error and page error (hydration mismatches, React
 * warnings such as duplicate keys, thrown errors). The dev server has no
 * service worker, so its registration 404 is the one expected noise.
 */
function collectRenderErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (/sw\.js|ServiceWorker|bad HTTP response code \(404\)/.test(text)) return;
    errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Records every /api/trpc request the page makes. */
function recordApiRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/trpc")) urls.push(request.url());
  });
  return urls;
}

test("the prerendered article page carries the article and the list", async ({ request }) => {
  const response = await request.get("/demo/all?entry=welcome");
  expect(response.status()).toBe(200);
  const html = await response.text();

  // The article body is in the HTML (no client-side fetch needed to see it).
  expect(html).toContain("This interactive demo is the real Lion Reader UI");
  expect(html).toContain("Get Started");
  // The (hidden) list under the article is prerendered too, with crawlable
  // links — including the open (now read) entry itself, like the app's list.
  expect(html).toContain('href="/demo/all?entry=welcome"');
  expect(html).toContain('href="/demo/all?entry=performance"');
  // The open article was seeded read: no post-hydration flip of the toggle.
  expect(html).toContain("Mark as unread");
});

test("the prerendered list page carries the entries", async ({ request }) => {
  const html = await (await request.get("/demo/tag/features")).text();
  expect(html).toContain('href="/demo/tag/features?entry=performance"');
  expect(html).toContain("Features");
  // A list page prerenders the list, not a reader.
  expect(html).not.toContain("Back to list");
});

for (const url of [
  "/demo/all?entry=welcome",
  "/demo/tag/features?entry=performance",
  "/demo/starred",
]) {
  test(`${url} hydrates cleanly and runs entirely in-process`, async ({ page }) => {
    const renderErrors = collectRenderErrors(page);
    const apiRequests = recordApiRequests(page);

    await page.goto(url);
    await expect(page.getByRole("main")).toBeVisible();
    // Give hydration and the post-hydration effects time to settle.
    await page.waitForTimeout(1500);

    expect(renderErrors).toEqual([]);
    expect(apiRequests).toEqual([]);
  });
}

test("reading, starring and navigating work through the real reader", async ({ page }) => {
  const apiRequests = recordApiRequests(page);
  await page.goto("/demo/all");

  const allItems = page.getByRole("link", { name: /^All Items/ });
  await expect(allItems).toContainText("(26)");

  // Open an article from the list; it auto-marks read and the count drops.
  await page.getByRole("button", { name: /article: Obsessive Performance/ }).click();
  await expect(page).toHaveURL(/\/demo\/all\?entry=performance$/);
  await expect(
    page.getByRole("heading", { name: "Obsessive Performance", level: 1 })
  ).toBeVisible();
  await expect(allItems).toContainText("(25)");

  // Star it from the reader; the sidebar Starred count follows.
  const starred = page.getByRole("link", { name: /^Starred/ });
  const starredBefore = Number((await starred.textContent())!.match(/\((\d+)\)/)![1]);
  await page.getByRole("button", { name: "Add to starred" }).click();
  await expect(starred).toContainText(`(${starredBefore})`);
  // (The starred count is *unread* starred, and this one is now read, so the
  // badge is unchanged; unstar-then-mark-unread would raise it.)
  await page.getByRole("button", { name: "Mark as unread" }).click();
  await expect(starred).toContainText(`(${starredBefore + 1})`);

  // Back to the list: the entry stays visible (lists don't drop rows until a
  // navigation).
  await page.getByRole("button", { name: "Back to list" }).click();
  await expect(page).toHaveURL(/\/demo\/all$/);
  await expect(page.getByRole("button", { name: /article: Obsessive Performance/ })).toBeVisible();

  // Sidebar navigation keeps the /demo prefix and swaps the list.
  await page.getByRole("link", { name: /^Starred/ }).click();
  await expect(page).toHaveURL(/\/demo\/starred$/);
  await expect(page.getByRole("heading", { name: "Starred" })).toBeVisible();
  await expect(page.getByRole("button", { name: /article: Welcome to Lion Reader/ })).toBeVisible();

  // Search runs against the store, over body text: a term only the performance
  // article contains.
  await page.getByRole("button", { name: "Search entries" }).click();
  await page.getByRole("searchbox").fill("sub-100ms");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/q=sub-100ms/);
  await expect(page.getByRole("button", { name: /article: Obsessive Performance/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /article: Welcome to Lion Reader/ })).toHaveCount(
    0
  );

  expect(apiRequests).toEqual([]);
});

test("mark all read empties the unread view and the sidebar counts", async ({ page }) => {
  await page.goto("/demo/subscription/organization");
  await expect(page.getByRole("heading", { name: "Organization & Search" })).toBeVisible();

  await page.getByRole("button", { name: /Mark all/i }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Mark all/i })
    .click();

  await expect(page.getByText(/No unread entries in this subscription/)).toBeVisible();
  await expect(page.getByRole("link", { name: /^All Items/ })).toContainText("(23)");
});

test("the old highlights URL redirects to the starred list", async ({ request }) => {
  const response = await request.get("/demo/highlights?entry=welcome", { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(response.headers()["location"]).toContain("/demo/starred?entry=welcome");
});

test("a direct visit to the internal entry route normalizes to the public URL", async ({
  page,
}) => {
  const renderErrors = collectRenderErrors(page);
  await page.goto("/demo/entry/welcome");
  await expect(page).toHaveURL(/\/demo\/all\?entry=welcome$/);
  await expect(
    page.getByRole("heading", { name: "Welcome to Lion Reader", level: 1 })
  ).toBeVisible();
  await page.waitForTimeout(1000);
  expect(renderErrors).toEqual([]);
  // The article stayed open across the normalization (it was never closed and
  // reopened): its single auto-mark-read leaves the count at 25.
  await expect(page.getByRole("link", { name: /^All Items/ })).toContainText("(25)");
});

/**
 * E2E tests for server-rendering the entry list on a page load.
 *
 * The page's `entries.list` prefetch streams to the client while pending; the
 * list suspends on it during SSR and hydration only (useCanRenderStreamedQuery),
 * so the first page of entries is real HTML in the response instead of a
 * skeleton, hydrates without a mismatch, and client navigation afterwards
 * still renders lists without suspending.
 */

import { test, expect, type Locator, type Page } from "@playwright/test";
import {
  getDb,
  createConfirmedUser,
  createSubscribedFeed,
  createUnreadEntry,
  starEntry,
  loginAs,
  collectRenderErrors,
  closeTestConnections,
  type TestDb,
  type TestEntry,
  type TestFeed,
  type TestUser,
} from "./helpers";

test.afterAll(async () => {
  await closeTestConnections();
});

async function seedReader(
  db: TestDb
): Promise<{ user: TestUser; feed: TestFeed; entries: TestEntry[] }> {
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);
  const entries: TestEntry[] = [];
  for (let i = 0; i < 3; i++) {
    entries.push(
      await createUnreadEntry(db, { feedId: feed.feedId, userId: user.id, title: `SSR Post ${i}` })
    );
  }
  return { user, feed, entries };
}

/**
 * Waits until React has hydrated `locator`'s element. React tags every DOM node
 * it hydrates or creates with a `__reactFiber$…` property; server HTML that
 * hasn't hydrated yet has none.
 */
async function expectHydrated(locator: Locator): Promise<void> {
  await expect
    .poll(() =>
      locator.evaluate((el) => Object.keys(el).some((key) => key.startsWith("__reactFiber$")))
    )
    .toBe(true);
}

function entryRow(page: Page, entry: TestEntry): Locator {
  return page.locator(`[data-entry-id="${entry.id}"]`);
}

test("entry list routes serve their first page of entries in the server HTML", async ({
  request,
}) => {
  const { user, feed, entries } = await seedReader(getDb());
  const headers = { cookie: `session=${user.sessionToken}` };

  for (const path of ["/all", `/subscription/${feed.subscriptionId}`]) {
    const html = await (await request.get(path, { headers })).text();
    for (const entry of entries) {
      // A rendered row, not just the streamed query data.
      expect(html, path).toContain(`data-entry-id="${entry.id}"`);
    }
  }
});

test("a server-rendered list hydrates cleanly and client navigation still works", async ({
  page,
  baseURL,
}) => {
  const db = getDb();
  const { user, entries } = await seedReader(db);
  await starEntry(db, user.id, entries[0].id);
  await loginAs(page.context(), user, baseURL!);
  const renderErrors = collectRenderErrors(page);

  await page.goto("/all");
  for (const entry of entries) {
    await expect(page.locator(`[aria-label*="article: ${entry.title} "]`)).toBeVisible();
  }
  await expectHydrated(entryRow(page, entries[0]));

  // Client navigation renders the next list from its own query.
  await page.getByRole("link", { name: /^Starred/ }).click();
  await page.waitForURL("**/starred");
  await expect(page.locator(`[aria-label*="article: ${entries[0].title} "]`)).toBeVisible();
  await expect(page.locator(`[aria-label*="article: ${entries[1].title} "]`)).toHaveCount(0);

  // A deep link to an entry server-renders the (hidden) list under the
  // reader too, and closing the reader shows it, with the open entry (marked
  // read on open, possibly before the list hydrated) shown as read: hydration
  // never patches the server's "Mark as read" label, so the list must hydrate
  // from what the server rendered and then update from the store.
  await page.goto(`/all?entry=${entries[1].id}`);
  await expect(page.getByText(`Content for ${entries[1].title}`)).toBeVisible();
  await expectHydrated(entryRow(page, entries[1]));
  await page.getByRole("button", { name: "Back to list" }).click();
  await expect(page.locator(`[aria-label*="article: ${entries[2].title} "]`)).toBeVisible();
  await expect(
    entryRow(page, entries[1]).getByRole("button", { name: "Mark as unread" })
  ).toBeVisible();

  expect(renderErrors).toEqual([]);
});

test("a stored compact density is in the server-rendered list, which hydrates in place", async ({
  page,
  baseURL,
}) => {
  const db = getDb();
  const { user, entries } = await seedReader(db);
  await loginAs(page.context(), user, baseURL!);
  const renderErrors = collectRenderErrors(page);
  // Non-default stored preferences: React only sees these after hydration.
  // Anything that re-renders the list's Suspense boundary with them before it
  // hydrates (a context above it changing value) discards the server HTML.
  await page.addInitScript(() => {
    localStorage.setItem(
      "lion-reader-appearance-settings",
      JSON.stringify({ listDensity: "compact" })
    );
    localStorage.setItem("lion-reader:keyboard-shortcuts-enabled", "false");
  });
  // Record every context provider whose value changes, through the hook React
  // DevTools uses (production builds call it too). A provider changing value
  // before the list's boundary hydrates discards the server HTML, which only
  // shows when the list is slower than hydration, so assert the cause too.
  await page.addInitScript(() => {
    const CONTEXT_PROVIDER = 10; // React's fiber tag for <Context value>
    type Fiber = {
      tag: number;
      memoizedProps: { value?: unknown } | null;
      alternate: Fiber | null;
      child: Fiber | null;
      sibling: Fiber | null;
    };
    const values = new WeakMap<Fiber, unknown>();
    const changes: string[] = [];
    const walk = (fiber: Fiber | null): void => {
      for (; fiber; fiber = fiber.sibling) {
        if (fiber.tag === CONTEXT_PROVIDER) {
          const value = fiber.memoizedProps?.value;
          const known = values.has(fiber) ? fiber : fiber.alternate;
          if (known && values.has(known) && values.get(known) !== value) {
            changes.push(
              JSON.stringify(value, (_, v: unknown) => (typeof v === "function" ? "fn" : v))
            );
          }
          values.set(fiber, value);
          if (fiber.alternate) values.set(fiber.alternate, value);
        }
        walk(fiber.child);
      }
    };
    Object.assign(window, {
      contextChanges: changes,
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        checkDCE: () => {},
        onScheduleFiberRoot: () => {},
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
        onCommitFiberRoot: (_id: number, root: { current: Fiber }) => walk(root.current),
      },
    });
  });
  // Record the first row once it's on screen (a streamed boundary's content
  // arrives hidden and is then moved into place), with its height at the time.
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const row = document.querySelector("[data-entry-id]");
      const height = row?.getBoundingClientRect().height;
      if (!row || !height) return;
      observer.disconnect();
      Object.assign(window, {
        firstRow: row,
        firstRowWasServerHtml: !Object.keys(row).some((key) => key.startsWith("__reactFiber$")),
        firstRowHeight: height,
        firstRowSummaryShown: row.querySelector("p")?.checkVisibility() ?? false,
      });
    });
    observer.observe(document, { childList: true, subtree: true });
  });

  await page.goto("/all");
  const row = entryRow(page, entries[0]);
  await expectHydrated(row);

  const summary = row.getByText(`Summary for ${entries[0].title}`);
  await expect(summary).toBeHidden();
  const first = await page.evaluate(() => {
    const w = window as unknown as {
      firstRow: Element;
      firstRowWasServerHtml: boolean;
      firstRowHeight: number;
      firstRowSummaryShown: boolean;
    };
    return {
      wasServerHtml: w.firstRowWasServerHtml,
      height: w.firstRowHeight,
      summaryShown: w.firstRowSummaryShown,
      isStillRendered: w.firstRow === document.querySelector("[data-entry-id]"),
    };
  });
  expect(first.wasServerHtml).toBe(true);
  expect(first.isStillRendered).toBe(true);
  // Rendered compact from the start: no reflow once React reads the setting
  // (give or take the 1px divider, which moves as the streamed rows land).
  expect(first.summaryShown).toBe(false);
  expect(Math.abs((await row.boundingBox())!.height - first.height)).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(() => (window as unknown as { contextChanges: string[] }).contextChanges)
  ).toEqual([]);

  // Changing the setting still applies live.
  await page.locator('button[aria-haspopup="true"]').click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Appearance" }).click();
  await page.getByRole("button", { name: "Comfortable" }).click();
  await page.getByRole("link", { name: /^All/ }).click();
  await expect(summary).toBeVisible();

  expect(renderErrors).toEqual([]);
});

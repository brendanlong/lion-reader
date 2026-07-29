/**
 * Narration highlighting, end to end.
 *
 * The paragraph map is derived server-side and the `data-para-id`s it points at
 * are written client-side, so the two halves only line up if the real server and
 * the real browser number the same elements. The unit tests hold that invariant
 * against linkedom and jsdom; this holds it against the actual pair, on the
 * markup shapes narration used to drop entirely (issue #1451).
 */

import { test, expect } from "@playwright/test";
import crypto from "node:crypto";
import {
  getDb,
  closeTestConnections,
  createConfirmedUser,
  createSubscribedFeed,
  loginAs,
} from "./helpers";
import * as schema from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";

/** The shapes at issue: a bare wrapper, a definition list, a wrapped image. */
const CONTENT = [
  "<h2>Narration shapes</h2>",
  "<div>An editor emitted this paragraph as a div.</div>",
  "<dl><dt>Term</dt><dd>Its definition.</dd></dl>",
  "<details><summary>A summary</summary><p>Disclosure body.</p></details>",
  '<figure><div class="wp-block-image"><img src="/icon.png" alt="A cat"></div>',
  "<figcaption>My cat</figcaption></figure>",
  "<div>Loose text<p>and a paragraph beside it.</p></div>",
].join("");

test.afterAll(async () => {
  await closeTestConnections();
});

test("narrates and highlights the shapes that used to be skipped", async ({ page, baseURL }) => {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);

  const entryId = generateUuidv7();
  const now = new Date();
  await db.insert(schema.entries).values({
    id: entryId,
    feedId: feed.feedId,
    type: "web",
    guid: `e2e-${entryId}`,
    url: `https://example.com/e2e/posts/${entryId}`,
    title: "Narration shapes",
    contentOriginal: CONTENT,
    publishedAt: now,
    fetchedAt: now,
    lastSeenAt: now,
    contentHash: crypto.createHash("sha256").update(CONTENT).digest("hex"),
  });
  await db.insert(schema.userEntries).values({ userId: user.id, entryId });

  await loginAs(page.context(), user, baseURL!);
  await page.goto("/all");
  await page.locator(`[data-entry-id="${entryId}"]`).click();

  // Every shape's text reaches the page, whatever narration does with it.
  await expect(page.getByText("An editor emitted this paragraph as a div.")).toBeVisible();
  await expect(page.getByText("Its definition.")).toBeVisible();
  await expect(page.getByText("and a paragraph beside it.")).toBeVisible();

  // Starting narration is what makes the client mark up highlight targets.
  await page.getByRole("button", { name: "Listen" }).click();
  await expect(page.locator("[data-para-id]").first()).toBeAttached();

  // What the server says to narrate, and which element each paragraph points at.
  const generated = await page.request.post("/api/trpc/narration.generate?batch=1", {
    data: { 0: { json: { id: entryId, useLlmNormalization: false } } },
    headers: { "content-type": "application/json" },
  });
  expect(generated.ok()).toBe(true);
  const body = await generated.json();
  const { narration, paragraphMap } = body[0].result.data.json as {
    narration: string;
    paragraphMap: { n: number; o: number }[];
  };
  const paragraphs = narration.split(/\n\n+/).filter(Boolean);

  // Each spoken paragraph has a map entry, and each entry names an element that
  // exists in the rendered page.
  expect(paragraphMap).toHaveLength(paragraphs.length);
  const highlighted = await Promise.all(
    paragraphMap.map(async (entry) => {
      const target = page.locator(`[data-para-id="para-${entry.o}"]`);
      await expect(target).toHaveCount(1);
      return (await target.evaluate((el) => el.tagName.toLowerCase())) as string;
    })
  );

  // The shapes this fixes: the div speaks for itself, the definition list's
  // terms speak, the figure speaks its wrapped image with its caption, and the
  // wrapper's loose text speaks without swallowing the paragraph beside it.
  expect(paragraphs).toEqual([
    "Narration shapes",
    "An editor emitted this paragraph as a div.",
    "Term",
    "Its definition.",
    "A summary",
    "Disclosure body.",
    "Image: A cat. My cat",
    "Loose text",
    "and a paragraph beside it.",
  ]);
  expect(highlighted).toEqual(["h2", "div", "dt", "dd", "summary", "p", "figure", "div", "p"]);
});

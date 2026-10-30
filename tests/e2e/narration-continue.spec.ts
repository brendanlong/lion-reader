/**
 * Narration going on to the next article in the list when one ends, with the
 * browser's speech replaced by one that finishes each utterance at once and
 * records what it was asked to say.
 */

import { test, expect, type Page } from "@playwright/test";
import {
  getDb,
  closeTestConnections,
  createConfirmedUser,
  createSubscribedFeed,
  createUnreadEntry,
  loginAs,
} from "./helpers";
import { eq } from "drizzle-orm";
import * as schema from "../../src/server/db/schema";
import {
  END_OF_ARTICLE,
  NEXT_ARTICLE,
  NO_MORE_ARTICLES,
} from "../../src/lib/narration/paragraph-map";

test.afterAll(async () => {
  await closeTestConnections();
});

async function fakeSpeech(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const spoken: string[] = [];
    (window as unknown as { spoken: string[] }).spoken = spoken;
    const voice = {
      default: true,
      lang: "en-US",
      localService: true,
      name: "Fake",
      voiceURI: "fake",
    };
    class Utterance extends EventTarget {
      voice = null;
      rate = 1;
      pitch = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {
        super();
      }
    }
    const synthesis = {
      speaking: false,
      paused: false,
      pending: false,
      onvoiceschanged: null,
      getVoices: () => [voice],
      speak(utterance: Utterance) {
        spoken.push(utterance.text);
        setTimeout(() => utterance.onend?.(), 10);
      },
      cancel() {},
      pause() {},
      resume() {},
    };
    Object.defineProperty(window, "speechSynthesis", { value: synthesis, configurable: true });
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      value: Utterance,
      configurable: true,
    });
  });
}

const spoken = (page: Page) =>
  page.evaluate(() => (window as unknown as { spoken: string[] }).spoken);

/**
 * Opens the first of `titles` listed (newest first), each an article saying
 * "Content for <title>" unless `silent` says it has nothing to say.
 */
async function openFirst(page: Page, baseURL: string, titles: string[], silent: string[] = []) {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);
  for (const title of [...titles].reverse()) {
    const entry = await createUnreadEntry(db, { feedId: feed.feedId, userId: user.id, title });
    if (silent.includes(title)) {
      await db
        .update(schema.entries)
        .set({ contentOriginal: "<p>↩</p>" })
        .where(eq(schema.entries.id, entry.id));
    }
  }

  await fakeSpeech(page);
  await loginAs(page.context(), user, baseURL);
  await page.goto("/all");
  const rows = page.locator("[data-entry-id]");
  await expect(rows).toHaveCount(titles.length);
  await expect(rows.first()).toContainText(titles[0]);
  const ids = await rows.evaluateAll((elements) =>
    elements.map((el) => el.getAttribute("data-entry-id"))
  );
  await rows.first().click();
  return ids;
}

test("narration goes on to the next article, and says when the list has ended", async ({
  page,
  baseURL,
}) => {
  const [, second] = await openFirst(page, baseURL!, ["Alpha", "Beta"]);
  await page.getByRole("button", { name: "Listen" }).click();

  await expect(page).toHaveURL(new RegExp(`entry=${second}$`));
  await expect.poll(() => spoken(page)).toContain(NO_MORE_ARTICLES);
  expect(await spoken(page)).toEqual([
    "Content for Alpha",
    END_OF_ARTICLE,
    NEXT_ARTICLE,
    "Content for Beta",
    END_OF_ARTICLE,
    NO_MORE_ARTICLES,
  ]);
});

test("narration passes over an article with nothing to say", async ({ page, baseURL }) => {
  const [, , third] = await openFirst(page, baseURL!, ["Alpha", "Beta", "Gamma"], ["Beta"]);
  await page.getByRole("button", { name: "Listen" }).click();

  await expect(page).toHaveURL(new RegExp(`entry=${third}$`));
  await expect.poll(() => spoken(page)).toContain(NO_MORE_ARTICLES);
  expect(await spoken(page)).toEqual([
    "Content for Alpha",
    END_OF_ARTICLE,
    NEXT_ARTICLE,
    "Content for Gamma",
    END_OF_ARTICLE,
    NO_MORE_ARTICLES,
  ]);
});

test("narration stops at the end of the article with the setting off", async ({
  page,
  baseURL,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "lion-reader-narration-settings",
      JSON.stringify({ continueToNextArticle: false })
    );
  });
  const [first] = await openFirst(page, baseURL!, ["Alpha", "Beta"]);
  await page.getByRole("button", { name: "Listen" }).click();

  await expect.poll(() => spoken(page)).toContain(END_OF_ARTICLE);
  // Long enough for a move to the next article to have shown.
  await page.waitForTimeout(500);
  expect(await spoken(page)).toEqual(["Content for Alpha", END_OF_ARTICLE]);
  await expect(page).toHaveURL(new RegExp(`entry=${first}$`));
});

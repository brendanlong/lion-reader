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

async function openFirstOfTwo(page: Page, baseURL: string) {
  const db = getDb();
  const user = await createConfirmedUser(db);
  const feed = await createSubscribedFeed(db, user.id);
  await createUnreadEntry(db, { feedId: feed.feedId, userId: user.id, title: "Older" });
  await createUnreadEntry(db, { feedId: feed.feedId, userId: user.id, title: "Newer" });

  await fakeSpeech(page);
  await loginAs(page.context(), user, baseURL);
  await page.goto("/all");
  const rows = page.locator("[data-entry-id]");
  await expect(rows).toHaveCount(2);
  const listed = await rows.evaluateAll((elements) =>
    elements.map((el) => ({
      id: el.getAttribute("data-entry-id"),
      title: el.textContent?.includes("Newer") ? "Newer" : "Older",
    }))
  );
  await rows.first().click();
  return listed;
}

test("narration goes on to the next article, and says when the list has ended", async ({
  page,
  baseURL,
}) => {
  const [first, second] = await openFirstOfTwo(page, baseURL!);
  await page.getByRole("button", { name: "Listen" }).click();

  await expect(page).toHaveURL(new RegExp(`entry=${second.id}$`));
  await expect.poll(() => spoken(page)).toContain(NO_MORE_ARTICLES);
  expect(await spoken(page)).toEqual([
    `Content for ${first.title}`,
    END_OF_ARTICLE,
    NEXT_ARTICLE,
    `Content for ${second.title}`,
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
  const [first] = await openFirstOfTwo(page, baseURL!);
  await page.getByRole("button", { name: "Listen" }).click();

  await expect.poll(() => spoken(page)).toContain(END_OF_ARTICLE);
  // Long enough for a move to the next article to have shown.
  await page.waitForTimeout(500);
  expect(await spoken(page)).toEqual([`Content for ${first.title}`, END_OF_ARTICLE]);
  await expect(page).toHaveURL(new RegExp(`entry=${first.id}$`));
});

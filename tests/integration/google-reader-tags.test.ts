/**
 * Google Reader label routes match tag names ignoring case, like tag
 * uniqueness: adding a label reuses the existing tag, and renaming onto
 * another tag's name is a conflict.
 */

import { describe, it, expect, afterAll } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../src/server/db";
import { subscriptions, subscriptionTags, tags, users } from "../../src/server/db/schema";
import { createSession } from "../../src/server/auth/session";
import { OAUTH_SCOPES } from "../../src/server/oauth/utils";
import { POST as editSubscription } from "../../src/app/api/greader.php/reader/api/0/subscription/edit/route";
import { POST as renameTag } from "../../src/app/api/greader.php/reader/api/0/rename-tag/route";
import { createTestFeed, createTestSubscription, createTestTag, createTestUser } from "./helpers";

const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

async function createReader(): Promise<{ userId: string; token: string }> {
  const userId = await createTestUser({ emailPrefix: "greader-tags" });
  createdUserIds.push(userId);
  const { token } = await createSession(db, {
    userId,
    scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
  });
  return { userId, token };
}

function formPost(path: string, token: string, form: Record<string, string>): Request {
  return new Request(`https://example.com/api/greader.php/reader/api/0/${path}`, {
    method: "POST",
    headers: {
      authorization: `GoogleLogin auth=${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
}

describe("Google Reader labels", () => {
  it("adds a label to the existing tag whose name differs only in case", async () => {
    const { userId, token } = await createReader();
    const newsId = await createTestTag(userId, { name: "News" });
    const subscriptionId = await createTestSubscription(userId, await createTestFeed());
    const [{ streamId }] = await db
      .select({ streamId: subscriptions.greaderStreamId })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId));

    const res = await editSubscription(
      formPost("subscription/edit", token, {
        ac: "edit",
        s: `feed/${streamId}`,
        a: "user/-/label/news",
      })
    );

    expect(res.status).toBe(200);
    const attached = await db
      .select({ tagId: subscriptionTags.tagId })
      .from(subscriptionTags)
      .where(eq(subscriptionTags.subscriptionId, subscriptionId));
    expect(attached).toEqual([{ tagId: newsId }]);
    const liveTags = await db
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.userId, userId), isNull(tags.deletedAt)));
    expect(liveTags).toHaveLength(1);
  });

  it("refuses to rename a label onto another tag's name, ignoring case", async () => {
    const { userId, token } = await createReader();
    await createTestTag(userId, { name: "Tech" });
    await createTestTag(userId, { name: "News" });

    const res = await renameTag(
      formPost("rename-tag", token, { s: "user/-/label/Tech", dest: "user/-/label/news" })
    );

    expect(res.status).toBe(409);
  });
});

/**
 * Seeds a user with a feed and a few unread entries, mints a first-party app
 * OAuth token for them, and prints `{ serverUrl, userId, accessToken,
 * refreshToken, entryIds }` as JSON. Used by the native app's real-server tests
 * (kmp/shared/src/jvmTest/.../RealServerTest.kt) against a running server on
 * the same database.
 */

import { sql } from "drizzle-orm";
import { db } from "../src/server/db";
import { entries, feeds, subscriptions, users } from "../src/server/db/schema";
import { insertUserEntriesWithMemberships } from "../src/server/services/subscription-entries";
import { generateUuidv7 } from "../src/lib/uuidv7";
import { createTokens } from "../src/server/oauth/service";
import { APP_CLIENT_ID, getAppResourceIdentifier } from "../src/server/oauth/app-client";
import { getIssuer } from "../src/server/oauth/config";
import { OAUTH_SCOPES } from "../src/server/oauth/utils";

async function main(): Promise<void> {
  const now = Date.now();
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `app-fixture-${userId}@test.com`,
    passwordHash: "unused",
    tosAgreedAt: new Date(now),
    privacyPolicyAgreedAt: new Date(now),
    notEuAgreedAt: new Date(now),
  });

  const feedId = generateUuidv7();
  await db.insert(feeds).values({
    id: feedId,
    url: `https://example.com/app-fixture-${feedId}.xml`,
    title: "Fixture Feed",
  });
  const subscriptionId = generateUuidv7();
  await db.insert(subscriptions).values({ id: subscriptionId, userId, feedId, type: "web" });

  const entryIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = generateUuidv7();
    const fetchedAt = new Date(now - i * 60 * 60 * 1000);
    await db.insert(entries).values({
      id,
      ownerFeedId: feedId,
      type: "web",
      guid: `fixture-${id}`,
      title: `Fixture entry ${i + 1}`,
      contentOriginal: `<p>Body of fixture entry ${i + 1}</p>`,
      contentHash: `fixture-${id}`,
      fetchedAt,
      publishedAt: fetchedAt,
      lastSeenAt: fetchedAt,
    });
    await insertUserEntriesWithMemberships(
      db,
      sql`SELECT ${subscriptionId}::uuid AS subscription_id, ${userId}::uuid AS user_id,
                 ${id}::uuid AS entry_id, ${new Date(fetchedAt)}::timestamptz AS published_or_fetched_at,
                 false AS is_spam, false AS read`
    );
    entryIds.push(id);
  }

  const tokens = await createTokens({
    clientId: APP_CLIENT_ID,
    userId,
    scopes: [OAUTH_SCOPES.READER_FULL_ACCESS],
    resource: getAppResourceIdentifier(),
  });
  process.stdout.write(
    JSON.stringify({
      serverUrl: getIssuer(),
      userId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      entryIds,
    })
  );
  process.exit(0);
}

void main();

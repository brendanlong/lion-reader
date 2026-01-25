/**
 * Script to manually trigger WebSub subscription from Lion Reader.
 * This allows us to test the subscription flow without going through the full feed fetch process.
 */

import { db } from "../src/server/db";
import { feeds } from "../src/server/db/schema";
import { subscribeToHub } from "../src/server/feed/websub";
import { eq } from "drizzle-orm";

async function main() {
  const feedUrl = "http://localhost:9001/feed.atom";

  console.log("Looking up feed:", feedUrl);

  const [feed] = await db.select().from(feeds).where(eq(feeds.url, feedUrl)).limit(1);

  if (!feed) {
    console.error("Feed not found!");
    process.exit(1);
  }

  console.log("Found feed:", {
    id: feed.id,
    url: feed.url,
    hubUrl: feed.hubUrl,
    selfUrl: feed.selfUrl,
    websubActive: feed.websubActive,
  });

  console.log("\nTriggering WebSub subscription...");

  const result = await subscribeToHub(feed);

  console.log("\nSubscription result:", result);

  // Check database state
  const [updatedFeed] = await db.select().from(feeds).where(eq(feeds.id, feed.id)).limit(1);

  console.log("\nUpdated feed state:", {
    websubActive: updatedFeed?.websubActive,
  });

  process.exit(0);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

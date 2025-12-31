/**
 * Seed script for development data.
 *
 * Usage: pnpm db:seed
 *
 * This creates sample data for local development including:
 * - A test user with a known password
 * - Sample feeds (tech blogs, news)
 * - Sample entries for each feed
 * - Subscriptions linking the user to feeds
 * - Some user entry states (read/starred)
 */

import { createHash } from "crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { generateUuidv7 } from "../src/lib/uuidv7";
import * as schema from "../src/server/db/schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("DATABASE_URL environment variable is not set");
  process.exit(1);
}

const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });

// Simple password hash for development (NOT for production - use argon2)
function hashPassword(password: string): string {
  return createHash("sha256").update(password).digest("hex");
}

// Generate a content hash for entries
function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function seed() {
  console.log("Seeding database...\n");

  // Clear existing data (in reverse order of dependencies)
  console.log("Clearing existing data...");
  await db.delete(schema.userEntries);
  await db.delete(schema.subscriptions);
  await db.delete(schema.entries);
  await db.delete(schema.feeds);
  await db.delete(schema.sessions);
  await db.delete(schema.jobs);
  await db.delete(schema.users);

  // Create test user
  console.log("Creating test user...");
  const userId = generateUuidv7();
  const [user] = await db
    .insert(schema.users)
    .values({
      id: userId,
      email: "test@example.com",
      passwordHash: hashPassword("password123"), // Dev only!
      emailVerifiedAt: new Date(),
    })
    .returning();
  console.log(`  Created user: ${user.email} (password: password123)`);

  // Create sample feeds
  console.log("\nCreating sample feeds...");
  const feedsData = [
    {
      id: generateUuidv7(),
      type: "rss" as const,
      url: "https://blog.rust-lang.org/feed.xml",
      title: "Rust Blog",
      description: "Empowering everyone to build reliable and efficient software",
      siteUrl: "https://blog.rust-lang.org",
    },
    {
      id: generateUuidv7(),
      type: "atom" as const,
      url: "https://github.blog/feed/",
      title: "The GitHub Blog",
      description:
        "Updates, ideas, and inspiration from GitHub to help developers build and design software",
      siteUrl: "https://github.blog",
    },
    {
      id: generateUuidv7(),
      type: "rss" as const,
      url: "https://blog.cloudflare.com/rss/",
      title: "The Cloudflare Blog",
      description: "The latest news on Cloudflare products, technology, and infrastructure",
      siteUrl: "https://blog.cloudflare.com",
    },
  ];

  const feeds = await db.insert(schema.feeds).values(feedsData).returning();
  console.log(`  Created ${feeds.length} feeds`);

  // Create sample entries for each feed
  console.log("\nCreating sample entries...");
  let totalEntries = 0;
  const allEntries: schema.Entry[] = [];

  for (const feed of feeds) {
    const entriesData = Array.from({ length: 5 }, (_, i) => {
      const content = `<p>This is sample content for entry ${i + 1} from ${feed.title}.</p>
        <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod
        tempor incididunt ut labore et dolore magna aliqua.</p>`;

      return {
        id: generateUuidv7(),
        feedId: feed.id,
        type: feed.type,
        guid: `${feed.url}/entry-${i + 1}`,
        url: `${feed.siteUrl}/posts/sample-post-${i + 1}`,
        title: `Sample Post ${i + 1} from ${feed.title}`,
        author: "Sample Author",
        contentOriginal: content,
        summary: `This is sample content for entry ${i + 1} from ${feed.title}...`,
        publishedAt: new Date(Date.now() - i * 24 * 60 * 60 * 1000), // Each day older
        fetchedAt: new Date(Date.now() - i * 24 * 60 * 60 * 1000),
        contentHash: hashContent(content),
      };
    });

    const entries = await db.insert(schema.entries).values(entriesData).returning();
    allEntries.push(...entries);
    totalEntries += entries.length;
  }
  console.log(`  Created ${totalEntries} entries`);

  // Create subscriptions for the user to all feeds
  console.log("\nCreating subscriptions...");
  const subscriptionsData = feeds.map((feed) => ({
    id: generateUuidv7(),
    userId: user.id,
    feedId: feed.id,
    subscribedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Subscribed 7 days ago
  }));

  const subscriptions = await db.insert(schema.subscriptions).values(subscriptionsData).returning();
  console.log(`  Created ${subscriptions.length} subscriptions`);

  // Create user entries (visibility + read/starred state)
  // In the new model, row existence = visibility
  console.log("\nCreating user entries...");
  const userEntriesData = allEntries.map((entry, i) => ({
    userId: user.id,
    entryId: entry.id,
    read: i < 5, // First 5 are read
    starred: i % 3 === 0, // Every 3rd is starred
    readAt: i < 5 ? new Date() : null,
    starredAt: i % 3 === 0 ? new Date() : null,
  }));

  await db.insert(schema.userEntries).values(userEntriesData);
  console.log(`  Created ${userEntriesData.length} user entries`);

  // Create a sample job
  console.log("\nCreating sample job...");
  const now = new Date();
  await db.insert(schema.jobs).values({
    id: generateUuidv7(),
    type: "fetch_feed",
    payload: JSON.stringify({ feedId: feeds[0].id }),
    enabled: true,
    nextRunAt: now,
    createdAt: now,
    updatedAt: now,
  });
  console.log("  Created 1 sample job");

  console.log("\n✓ Seed completed successfully!");
  console.log("\nYou can log in with:");
  console.log("  Email: test@example.com");
  console.log("  Password: password123");
}

seed()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });

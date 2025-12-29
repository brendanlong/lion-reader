/**
 * Debug script to check narration data and paragraph mappings.
 * Run with: tsx scripts/check-narration-data.ts
 */

import { db } from "../src/server/db";
import { narrationContent } from "../src/server/db/schema";
import { sql } from "drizzle-orm";

async function checkNarrationData() {
  console.log("Checking narration data...\n");

  // Check if any narration records exist
  const totalRecords = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(narrationContent);

  console.log(`Total narration records: ${totalRecords[0]?.count ?? 0}`);

  // Check how many have content_narration (non-null means they haven't been cleared)
  const recordsWithContent = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(narrationContent)
    .where(sql`${narrationContent.contentNarration} IS NOT NULL`);

  console.log(`Records with narration content: ${recordsWithContent[0]?.count ?? 0}`);

  // Check how many have paragraph_map
  const recordsWithMap = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(narrationContent)
    .where(sql`${narrationContent.paragraphMap} IS NOT NULL`);

  console.log(`Records with paragraph map: ${recordsWithMap[0]?.count ?? 0}`);

  // Sample a few records
  const sampleRecords = await db
    .select({
      id: narrationContent.id,
      hasContent: sql<boolean>`${narrationContent.contentNarration} IS NOT NULL`,
      hasMap: sql<boolean>`${narrationContent.paragraphMap} IS NOT NULL`,
      generatedAt: narrationContent.generatedAt,
    })
    .from(narrationContent)
    .limit(5);

  console.log("\nSample records:");
  console.table(sampleRecords);

  if (recordsWithContent[0]?.count ?? 0 > 0) {
    console.log(
      "\n⚠️  WARNING: Found narration records with content! These have OLD paragraph mappings."
    );
    console.log("   Run the migration to clear them: pnpm db:migrate");
  } else {
    console.log(
      "\n✅ All narration records have been cleared. New narration will be generated correctly."
    );
  }

  process.exit(0);
}

checkNarrationData().catch((error) => {
  console.error("Error checking narration data:", error);
  process.exit(1);
});

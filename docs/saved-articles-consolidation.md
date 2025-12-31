# Saved Articles Consolidation Design

## Overview

This document describes consolidating the `saved_articles` table into the existing `entries` table, following the pattern established by email subscriptions. Saved articles become entries in a special per-user "saved" feed, unifying the data model and enabling features like combined starred views.

## Current State

### Saved Articles Table
```sql
saved_articles (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  site_name TEXT,
  author TEXT,
  image_url TEXT,
  content_original TEXT,
  content_cleaned TEXT,
  excerpt TEXT,
  content_hash TEXT,
  read BOOLEAN,
  starred BOOLEAN,
  read_at TIMESTAMPTZ,
  starred_at TIMESTAMPTZ,
  saved_at TIMESTAMPTZ,
  ...
)
```

### Problems with Current Design

1. **Duplicated state tracking**: Both `saved_articles` and `user_entries` have `read`, `starred`, `read_at`, `starred_at` columns
2. **Separate API surface**: `saved.*` router duplicates most of `entries.*` operations
3. **No unified views**: Can't easily show "all starred items" across feed entries and saved articles
4. **Inconsistent patterns**: Saved articles use a different model than feed/email entries

## Proposed Design

### Follow the Email Feed Pattern

Email subscriptions established that feeds can be per-user:
- `feeds.type = 'email'` → `feeds.user_id` is set
- `feeds.type IN ('rss', 'atom', 'json')` → `feeds.user_id` is NULL (shared)

Saved articles follow the same pattern:
- `feeds.type = 'saved'` → `feeds.user_id` is set
- One "saved" feed per user containing all their saved articles

### Schema Changes

#### 1. Add 'saved' to feed_type enum

```sql
ALTER TYPE feed_type ADD VALUE 'saved';
```

#### 2. Update feeds check constraint

```sql
ALTER TABLE feeds DROP CONSTRAINT feed_type_user_id;
ALTER TABLE feeds ADD CONSTRAINT feed_type_user_id
  CHECK ((type IN ('email', 'saved')) = (user_id IS NOT NULL));

-- Unique constraint: one saved feed per user
CREATE UNIQUE INDEX uq_feeds_saved_user
  ON feeds (user_id)
  WHERE type = 'saved';
```

#### 3. Make guid nullable on entries

Many feeds don't provide reliable guids, and saved articles don't have them at all.

```sql
ALTER TABLE entries ALTER COLUMN guid DROP NOT NULL;
```

#### 4. Add saved article metadata columns to entries

```sql
ALTER TABLE entries
  ADD COLUMN site_name TEXT,
  ADD COLUMN image_url TEXT;
```

Note: `excerpt` maps to existing `summary` column.

#### 5. Update unique constraints on entries

```sql
-- Drop existing constraint
ALTER TABLE entries DROP CONSTRAINT uq_entries_feed_guid;

-- Feed/email entries: unique by (feed_id, guid) when guid exists
CREATE UNIQUE INDEX uq_entries_feed_guid
  ON entries (feed_id, guid)
  WHERE guid IS NOT NULL;

-- Saved articles: unique by (feed_id, url)
-- Use a join via subquery isn't possible, so we check feed type
-- Option A: Just enforce (feed_id, url) for saved feeds at application level
-- Option B: Denormalize feed type onto entries (adds complexity)
-- Recommendation: Application-level enforcement + general (feed_id, url) index

CREATE UNIQUE INDEX uq_entries_saved_url
  ON entries (feed_id, url);
  -- This prevents duplicate URLs in ANY feed, which is reasonable
```

### Updated Schema (Drizzle)

```typescript
export const feedTypeEnum = pgEnum("feed_type", ["rss", "atom", "json", "email", "saved"]);

export const feeds = pgTable(
  "feeds",
  {
    // ... existing columns ...
  },
  (table) => [
    // ... existing indexes ...
    check("feed_type_user_id", sql`(type IN ('email', 'saved')) = (user_id IS NOT NULL)`),
    unique("uq_feeds_saved_user").on(table.userId).where(sql`type = 'saved'`),
  ]
);

export const entries = pgTable(
  "entries",
  {
    // ... existing columns ...
    guid: text("guid"), // Now nullable
    siteName: text("site_name"), // New
    imageUrl: text("image_url"), // New
  },
  (table) => [
    // Partial unique index for entries with guids
    // (Drizzle may need raw SQL for this)
    index("idx_entries_feed").on(table.feedId, table.id),
    // ...
  ]
);
```

## Saved Feed Management

### Helper Function

```typescript
/**
 * Gets or creates the user's saved articles feed.
 * Idempotent - safe to call multiple times.
 */
async function getOrCreateSavedFeed(db: DB, userId: string): Promise<string> {
  // Try to find existing saved feed
  const existing = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(and(eq(feeds.type, 'saved'), eq(feeds.userId, userId)))
    .limit(1);

  if (existing.length > 0) {
    return existing[0].id;
  }

  // Create new saved feed
  const feedId = generateUuidv7();
  await db.insert(feeds).values({
    id: feedId,
    type: 'saved',
    userId,
    title: 'Saved Articles',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return feedId;
}
```

### Usage

- **On save**: Call `getOrCreateSavedFeed()`, then insert entry
- **On list**: Call `getOrCreateSavedFeed()` to ensure feed exists (returns empty if no entries)
- **Self-healing**: If feed is deleted, it's recreated on next interaction

## Visibility Rules

### Current Rules (entries.list)

```typescript
// Entry must be from active subscription OR starred
conditions.push(
  or(
    inArray(entries.feedId, activeSubscriptionFeedIds),
    eq(userEntries.starred, true)
  )
);
```

### Updated Rules

```typescript
// Entry must be:
// 1. From active subscription, OR
// 2. Starred, OR
// 3. From user's saved feed (always visible to owner)
const savedFeedIds = db
  .select({ id: feeds.id })
  .from(feeds)
  .where(and(eq(feeds.type, 'saved'), eq(feeds.userId, userId)));

conditions.push(
  or(
    inArray(entries.feedId, activeSubscriptionFeedIds),
    eq(userEntries.starred, true),
    inArray(entries.feedId, savedFeedIds)
  )
);
```

Alternatively, treat saved feed as implicitly subscribed (cleaner):
- When creating saved feed, also create a subscription row
- Then existing subscription logic handles visibility

## API Changes

### Option A: Keep Separate Routers (Recommended for now)

Keep `saved.*` router but reimplement using entries table:
- `saved.save` → Creates entry in saved feed
- `saved.list` → Lists entries from saved feed
- `saved.delete` → Deletes entry from saved feed
- `saved.markRead`, `saved.star`, etc. → Delegate to entries operations

Pros: No breaking API changes, gradual migration
Cons: Some code duplication

### Option B: Unified Entries Router

Add source filter to entries router:
```typescript
entries.list({
  source: 'all' | 'feeds' | 'saved',
  // ... other filters
})
```

Pros: Cleaner long-term
Cons: Breaking API change, more complex migration

### Recommendation

Start with Option A, migrate to Option B later if desired.

## Migration Plan

### Step 1: Schema Migration

```sql
-- 1. Add 'saved' to feed_type enum
ALTER TYPE feed_type ADD VALUE 'saved';

-- 2. Update check constraint
ALTER TABLE feeds DROP CONSTRAINT feed_type_user_id;
ALTER TABLE feeds ADD CONSTRAINT feed_type_user_id
  CHECK ((type IN ('email', 'saved')) = (user_id IS NOT NULL));

-- 3. Add unique constraint for saved feeds
CREATE UNIQUE INDEX uq_feeds_saved_user
  ON feeds (user_id)
  WHERE type = 'saved';

-- 4. Make guid nullable
ALTER TABLE entries ALTER COLUMN guid DROP NOT NULL;

-- 5. Update entries unique constraint
ALTER TABLE entries DROP CONSTRAINT uq_entries_feed_guid;
CREATE UNIQUE INDEX uq_entries_feed_guid
  ON entries (feed_id, guid)
  WHERE guid IS NOT NULL;
CREATE UNIQUE INDEX uq_entries_feed_url
  ON entries (feed_id, url);

-- 6. Add new columns to entries
ALTER TABLE entries
  ADD COLUMN site_name TEXT,
  ADD COLUMN image_url TEXT;
```

### Step 2: Data Migration

```sql
-- Create saved feeds for users with saved articles
INSERT INTO feeds (id, type, user_id, title, created_at, updated_at)
SELECT
  gen_uuidv7(),
  'saved',
  user_id,
  'Saved Articles',
  NOW(),
  NOW()
FROM (SELECT DISTINCT user_id FROM saved_articles) users;

-- Migrate saved articles to entries
INSERT INTO entries (
  id, feed_id, guid, url, title, author,
  content_original, content_cleaned, summary,
  site_name, image_url, content_hash,
  published_at, fetched_at, created_at, updated_at
)
SELECT
  sa.id,
  f.id,
  NULL,  -- guid is null for saved articles
  sa.url,
  sa.title,
  sa.author,
  sa.content_original,
  sa.content_cleaned,
  sa.excerpt,  -- maps to summary
  sa.site_name,
  sa.image_url,
  sa.content_hash,
  sa.saved_at,  -- use saved_at as published_at
  sa.saved_at,  -- use saved_at as fetched_at
  sa.created_at,
  sa.updated_at
FROM saved_articles sa
JOIN feeds f ON f.user_id = sa.user_id AND f.type = 'saved';

-- Create user_entries rows for saved articles
INSERT INTO user_entries (user_id, entry_id, read, starred, read_at, starred_at)
SELECT
  sa.user_id,
  sa.id,  -- entry id = saved article id (preserved)
  sa.read,
  sa.starred,
  sa.read_at,
  sa.starred_at
FROM saved_articles sa;
```

### Step 3: Update Application Code

1. Update schema.ts with new columns and constraints
2. Implement `getOrCreateSavedFeed()` helper
3. Update saved router to use entries table
4. Update entries.list visibility rules
5. Update any frontend code that depends on saved_articles structure

### Step 4: Drop Old Table

```sql
DROP TABLE saved_articles;
```

## Benefits

1. **Unified data model**: All content in one table with consistent structure
2. **Unified state tracking**: `user_entries` handles read/starred for everything
3. **Unified starred view**: Single query for all starred items
4. **Consistent patterns**: Saved feeds work like email feeds
5. **Simpler API**: Can eventually consolidate to single entries router
6. **Narration reuse**: Content hash already works across both (unchanged)

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Migration data loss | Run in transaction, test on staging first |
| API breaking changes | Keep saved router as wrapper initially |
| Performance regression | Add appropriate indexes before migration |
| Saved feed deletion | `getOrCreateSavedFeed()` recreates on demand |

## Future Considerations

1. **Unified search**: Can search across all entries once consolidated
2. **Combined "All Items" view**: Show feed entries + saved articles together
3. **Tagging saved articles**: Could reuse subscription tags infrastructure
4. **Import/export**: Single entries export covers everything

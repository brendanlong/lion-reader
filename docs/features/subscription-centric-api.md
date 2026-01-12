# Subscription-Centric API Design

## Overview

This document describes simplifying the API by hiding the internal feeds/subscriptions distinction from clients. Externally, the API exposes only subscription IDs as the primary key for user-facing feed operations. Database views abstract the feed-subscription join, making queries simpler while preserving the shared-feed optimization internally.

## Problem Statement

### Current Architecture

The system has two related concepts:

- **feeds**: Canonical feed data (URL, title, fetch state) - shared across users
- **subscriptions**: User-to-feed relationships (custom title, subscribe date) - per-user

This separation exists for efficiency: fetching `nytimes.com/rss` once serves all subscribers. However, this internal optimization leaks into the API:

```typescript
// Current API response shape
{
  subscription: { id, feedId, customTitle, subscribedAt },
  feed: { id, type, url, title, description, siteUrl }
}
```

### Problems

1. **Cognitive overhead**: Clients must understand and track two ID types
2. **Awkward filtering**: `entries.list({ feedId })` when users think in terms of subscriptions
3. **Cache key complexity**: Frontend cache must consider both subscription and feed IDs
4. **Leaky abstraction**: Users don't care that feeds are shared - they just have "their feeds"

### What Users Actually Need

From a user's perspective:

- "My feeds" (subscriptions with feed metadata merged)
- "Entries from this feed" (entries visible to me from a subscription)
- One ID to reference everything

## Proposed Design

### Core Principle

**Subscription ID becomes the only user-facing identifier.** Feed ID becomes an internal implementation detail, like a database foreign key that clients never see.

### Database Views

#### 1. `user_feeds` View

Presents subscriptions with feed data merged, using `subscription.id` as the primary key:

```sql
CREATE VIEW user_feeds AS
SELECT
  s.id,                                           -- subscription_id is THE id
  s.user_id,
  s.subscribed_at,
  s.feed_ids,                                     -- for entry visibility (internal)
  f.type,
  COALESCE(s.custom_title, f.title) AS title,    -- resolved title
  f.title AS original_title,                      -- for "rename" UI
  f.url,
  f.site_url,
  f.description
FROM subscriptions s
JOIN feeds f ON f.id = s.feed_id
WHERE s.unsubscribed_at IS NULL;
```

#### 2. `visible_entries` View

Presents entries with subscription context, handling the visibility rules:

```sql
CREATE VIEW visible_entries AS
SELECT
  ue.user_id,
  e.id,
  e.type,
  e.url,
  e.title,
  e.author,
  e.summary,
  e.content_cleaned,
  e.published_at,
  e.fetched_at,
  ue.read,
  ue.starred,
  s.id AS subscription_id                         -- links entry to subscription
FROM user_entries ue
JOIN entries e ON e.id = ue.entry_id
LEFT JOIN subscriptions s ON (
  s.user_id = ue.user_id
  AND e.feed_id = ANY(s.feed_ids)                 -- handles redirect history
)
WHERE
  s.unsubscribed_at IS NULL                       -- active subscription
  OR ue.starred = true;                           -- OR starred (keeps subscription_id even if unsubscribed)
```

**Key design choice**: The LEFT JOIN finds _any_ matching subscription (active or not), then the WHERE clause determines visibility. This means:

- Active subscription entries: `subscription_id` present
- Starred entries from unsubscribed feeds: `subscription_id` still present (useful for cache handling if user resubscribes)
- Starred entries with no subscription ever: `subscription_id` NULL (edge case, truly orphaned)

### API Response Changes

#### Current (nested)

```typescript
// subscriptions.list response
{
  items: [
    {
      subscription: { id, feedId, customTitle, subscribedAt },
      feed: { id, type, url, title, description, siteUrl },
      unreadCount: number,
      tags: [{ id, name, color }],
    },
  ];
}
```

#### Proposed (flat)

```typescript
// subscriptions.list response
{
  items: [
    {
      id: string, // subscription_id
      type: "web" | "email" | "saved",
      url: string | null,
      title: string, // resolved (custom or original)
      originalTitle: string, // for rename UI
      description: string | null,
      siteUrl: string | null,
      subscribedAt: string,
      unreadCount: number,
      tags: [{ id, name, color }],
    },
  ];
}
```

**Note**: `feedId` is removed from the response entirely.

#### Entry Filtering

```typescript
// Current
entries.list({ feedId: "..." });

// Proposed
entries.list({ subscriptionId: "..." });
```

### What Still Uses Feed Internally

Some operations inherently need the feed concept:

| Operation          | Needs Feed? | Notes                                    |
| ------------------ | ----------- | ---------------------------------------- |
| Subscribe          | Yes         | Creates/finds feed, then subscription    |
| Unsubscribe        | No          | Just updates subscription                |
| List subscriptions | Via view    | View handles join                        |
| List entries       | Via view    | View includes subscription_id            |
| Mark read/star     | No          | Uses entry_id directly                   |
| Feed preview       | Yes         | Pre-subscription, no subscription exists |
| Feed discovery     | Yes         | Pre-subscription, no subscription exists |
| Feed stats/health  | Yes         | Fetch timing, errors, WebSub status      |
| Background worker  | Yes         | Fetches by feed, not subscription        |

### Edge Cases

#### 1. Feed Preview (Before Subscribing)

The `feeds.preview` and `feeds.discover` endpoints remain unchanged - they return feed data without subscription context because no subscription exists yet.

After subscribing, the feed becomes accessible via its subscription ID.

#### 2. Feed Stats/Health Page

This page shows fetch timing, consecutive failures, WebSub status - data that lives on feeds.

Options:

- Keep a separate `feedStats` endpoint that accepts subscription ID, maps to feed internally
- Rename to "subscription health" in the UI
- Return stats as part of subscription detail response

Recommendation: Add optional `includeStats: boolean` to subscription detail endpoint.

#### 3. Starred Entries from Unsubscribed Feeds

The view keeps `subscription_id` even for unsubscribed feeds when entries are starred. This means:

- Cache invalidation by subscription ID still works
- If user resubscribes (reactivating the same subscription row), starred entries already have the right ID
- UI can show "from [Feed Name] (unsubscribed)" if desired

#### 4. Multiple Paths to Same Entry (Redirect History)

The `feed_ids` array contains `[current_feed_id, ...previous_feed_ids]`. An entry might match via either the current or previous feed. The view handles this with `ANY(s.feed_ids)`.

Concern: Could an entry match multiple subscriptions? No - `(user_id, feed_id)` is unique on subscriptions, and the `feed_ids` arrays are disjoint per user.

## Implementation Plan

### Commit 1: Add database views for subscription-centric queries

Create migration `0035_subscription_views.sql`:

```sql
-- user_feeds: Subscriptions with feed metadata merged
CREATE VIEW user_feeds AS
SELECT
  s.id,
  s.user_id,
  s.subscribed_at,
  s.feed_id,           -- internal use only
  s.feed_ids,          -- for entry visibility
  s.custom_title,
  f.type,
  COALESCE(s.custom_title, f.title) AS title,
  f.title AS original_title,
  f.url,
  f.site_url,
  f.description
FROM subscriptions s
JOIN feeds f ON f.id = s.feed_id
WHERE s.unsubscribed_at IS NULL;

-- visible_entries: Entries with visibility rules and subscription context
CREATE VIEW visible_entries AS
SELECT
  ue.user_id,
  e.*,
  ue.read,
  ue.starred,
  s.id AS subscription_id
FROM user_entries ue
JOIN entries e ON e.id = ue.entry_id
LEFT JOIN subscriptions s ON (
  s.user_id = ue.user_id
  AND e.feed_id = ANY(s.feed_ids)
)
WHERE
  s.unsubscribed_at IS NULL
  OR ue.starred = true;
```

Files changed:

- `drizzle/0035_subscription_views.sql` (new)

### Commit 2: Add subscriptionId filter to entries router

Accept `subscriptionId` as primary filter, keep `feedId` as deprecated alias.

Files changed:

- `src/server/trpc/routers/entries.ts` - Add `subscriptionId` input, map to feed IDs internally

```typescript
// Input schema adds subscriptionId
subscriptionId: uuidSchema.optional(),
feedId: uuidSchema.optional(), // deprecated, alias for subscriptionId

// In query logic:
if (input.subscriptionId) {
  // Look up subscription's feed_ids and filter by those
  const sub = await db.select({ feedIds: subscriptions.feedIds })
    .from(subscriptions)
    .where(and(eq(subscriptions.id, input.subscriptionId), eq(subscriptions.userId, userId)))
    .limit(1);
  if (sub.length > 0) {
    conditions.push(inArray(entries.feedId, sub[0].feedIds));
  }
} else if (input.feedId) {
  // Deprecated: direct feedId filter
  conditions.push(eq(entries.feedId, input.feedId));
}
```

### Commit 3: Add subscriptionId to entry list response

Include `subscriptionId` in entry responses so frontend can associate entries with subscriptions.

Files changed:

- `src/server/trpc/routers/entries.ts` - Add subscriptionId to output schema and query

```typescript
// Output schema adds subscriptionId
subscriptionId: z.string().nullable(),

// Query joins to subscriptions to get subscription_id
// (Similar to visible_entries view logic)
```

### Commit 4: Flatten subscription list response

Change from nested `{ subscription, feed }` to flat object with subscription ID as primary key.

Files changed:

- `src/server/trpc/routers/subscriptions.ts` - Update output schema and formatters

Before:

```typescript
{
  subscription: { id, feedId, customTitle, subscribedAt },
  feed: { id, type, url, title, description, siteUrl },
  unreadCount,
  tags
}
```

After:

```typescript
{
  (id, // subscription ID
    type,
    url,
    title, // resolved (custom or original)
    originalTitle, // for rename UI
    description,
    siteUrl,
    subscribedAt,
    unreadCount,
    tags);
}
```

### Commit 5: Update Sidebar to use flat subscription response

Files changed:

- `src/components/layout/Sidebar.tsx`

### Commit 6: Update entry list hooks to use subscriptionId

Files changed:

- `src/lib/hooks/useEntryListQuery.ts` - Use `subscriptionId` instead of `feedId`
- `src/lib/hooks/useEntryMutations.ts` - Update cache keys if needed

### Commit 7: Update entry components for subscriptionId

Files changed:

- `src/components/entries/EntryList.tsx`
- `src/components/entries/EntryListItem.tsx`
- `src/components/entries/EntryContent.tsx`

### Commit 8: Rename feed route to subscription route

Files changed:

- `src/app/(app)/feed/[feedId]/` → `src/app/(app)/subscription/[id]/`
- Update any links/redirects referencing old route

### Commit 9: Update settings pages for subscription-centric model

Files changed:

- `src/app/(app)/settings/feed-stats/page.tsx` - Accept subscription ID, map to feed internally
- `src/app/(app)/settings/broken-feeds/page.tsx` - Similar updates

### Commit 10: Update real-time event handlers

Files changed:

- `src/lib/hooks/useRealtimeUpdates.ts`
- `src/app/api/v1/events/route.ts`

### Commit 11: Cleanup and documentation

Files changed:

- Remove deprecated `feedId` parameter after frontend migration complete
- Update OpenAPI schemas
- Update CLAUDE.md if needed

## Files Requiring Changes (Summary)

### Backend (Commits 1-4)

| File                                       | Change                               |
| ------------------------------------------ | ------------------------------------ |
| `drizzle/0035_subscription_views.sql`      | New migration for views              |
| `src/server/trpc/routers/entries.ts`       | Add subscriptionId filter and output |
| `src/server/trpc/routers/subscriptions.ts` | Flatten response shape               |

### Frontend (Commits 5-10, parallelizable)

| File                                           | Change                      |
| ---------------------------------------------- | --------------------------- |
| `src/components/layout/Sidebar.tsx`            | Use flat subscription shape |
| `src/lib/hooks/useEntryListQuery.ts`           | Use subscriptionId          |
| `src/lib/hooks/useEntryMutations.ts`           | Update cache handling       |
| `src/components/entries/EntryList.tsx`         | Use subscriptionId          |
| `src/components/entries/EntryListItem.tsx`     | Use subscriptionId          |
| `src/components/entries/EntryContent.tsx`      | Use subscriptionId          |
| `src/app/(app)/feed/[feedId]/*`                | Rename to subscription/[id] |
| `src/app/(app)/settings/feed-stats/page.tsx`   | Map subscription → feed     |
| `src/app/(app)/settings/broken-feeds/page.tsx` | Map subscription → feed     |
| `src/lib/hooks/useRealtimeUpdates.ts`          | Update event handling       |

### Internal (No API changes needed)

These files use `feedId` internally and don't need changes:

- `src/server/feed/*` - Internal feed fetching
- `src/server/jobs/*` - Background job handlers
- `src/server/email/*` - Email processing
- `src/app/api/webhooks/*` - WebSub callbacks

## Migration Notes

### Backwards Compatibility

- Old `feedId` parameter accepted as alias for `subscriptionId` (Phase 3)
- Old nested response shape can be maintained via response transformation if needed
- Views don't change underlying tables, so rollback is trivial

### Performance Considerations

- Views are essentially saved queries - no materialization overhead
- Indexes on underlying tables still apply
- May want to add index on `subscriptions.feed_ids` using GIN (already exists)
- Monitor query plans after migration

### Testing

1. Unit tests for view query correctness
2. Integration tests for API response shape changes
3. Test edge cases: starred orphans, redirect history, feed stats
4. Test backwards compatibility aliases

## Benefits

1. **Simpler mental model**: One ID type for users to track
2. **Cleaner API**: Flat response shape, intuitive parameter names
3. **Better caching**: Single key for cache invalidation
4. **Encapsulation**: Feed optimization is truly internal
5. **Query simplification**: Views handle the join complexity

## Risks and Mitigations

| Risk                  | Mitigation                                                 |
| --------------------- | ---------------------------------------------------------- |
| View performance      | Verify query plans, views use existing indexes             |
| Breaking API changes  | Phased rollout with backwards compatibility                |
| Edge cases missed     | Comprehensive test coverage for starred orphans, redirects |
| Feed stats complexity | Add stats to subscription detail, avoid separate endpoint  |

## Future Considerations

1. **Rename `feeds` router**: Could become `discovery` (for pre-subscription operations)
2. **Materialized views**: If performance becomes an issue (unlikely)
3. **GraphQL**: Flat model maps more naturally to GraphQL than nested
4. **Subscription groups**: If we add folders/categories, they'd use subscription IDs

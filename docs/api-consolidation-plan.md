# API Consolidation Plan: Unified Entries API

## Overview

With saved articles now consolidated into the `entries` table (using `type='saved'`), we can unify the API surface to reduce duplication and enable new features like unified starred views across all entry types.

## Current State

### Separate Routers

- **`entries.*`** - Feed entries (RSS/Atom/JSON)
- **`saved.*`** - Saved articles (read-it-later)

### Duplication

Both routers have nearly identical operations:

- `list` - Paginated listing with filters
- `get` - Get single item with full content
- `markRead` - Mark as read/unread
- `star/unstar` - Toggle starred status
- `count` - Get total/unread counts

### Client Usage

- **Web app**: Uses `trpc.saved.*` for saved articles, `trpc.entries.*` for feed entries
- **Android app**: Separate API endpoints, models, repositories, and screens for each

---

## Proposed Changes

### Phase 1: Backend - Add Type Filter to Entries Router

**Goal**: Allow `entries.list` to filter by entry type, enabling unified views.

**Changes to `src/server/trpc/routers/entries.ts`**:

1. Add `type` filter parameter to `entries.list`:

   ```typescript
   input: z.object({
     // ... existing params
     type: z.enum(["rss", "email", "saved"]).optional(),
     excludeTypes: z.array(z.enum(["rss", "email", "saved"])).optional(),
   });
   ```

2. Add `type` field to entry response schemas:

   ```typescript
   const entryListItemSchema = z.object({
     // ... existing fields
     type: z.enum(["rss", "email", "saved"]),
   });
   ```

3. Update query to filter by type when specified

**Files to modify**:

- `src/server/trpc/routers/entries.ts`

### Phase 2: Backend - Deprecate Redundant Saved Endpoints

**Goal**: Mark redundant endpoints as deprecated, pointing to unified alternatives.

**Endpoints to deprecate** (keep working for backwards compatibility):

- `saved.star` → Use `entries.star`
- `saved.unstar` → Use `entries.unstar`
- `saved.markRead` → Use `entries.markRead`
- `saved.list` → Use `entries.list({ type: 'saved' })`
- `saved.get` → Use `entries.get`

**Endpoints to keep** (unique functionality):

- `saved.save` - Special save-from-URL logic with content extraction
- `saved.delete` - Hard delete (entries use soft delete pattern)
- `saved.count` - Could be replaced by `entries.count({ type: 'saved' })` later

**Files to modify**:

- `src/server/trpc/routers/saved.ts` - Add deprecation notices in JSDoc
- `src/server/trpc/routers/entries.ts` - Add `entries.count` with type filter

### Phase 3: Web App - Migrate to Unified API

**Goal**: Update web app to use `entries.*` for saved article mutations.

#### 3a. Update Saved Articles Mutations Hook

**File**: `src/lib/hooks/useSavedArticleMutations.ts`

Change from:

```typescript
const markReadMutation = trpc.saved.markRead.useMutation(...)
const starMutation = trpc.saved.star.useMutation(...)
const unstarMutation = trpc.saved.unstar.useMutation(...)
```

To:

```typescript
const markReadMutation = trpc.entries.markRead.useMutation(...)
const starMutation = trpc.entries.star.useMutation(...)
const unstarMutation = trpc.entries.unstar.useMutation(...)
```

Update cache invalidation to handle both `saved.list` and `entries.list` queries.

#### 3b. Update Saved Articles List

**File**: `src/components/saved/SavedArticleList.tsx`

Option A (minimal change): Keep using `saved.list`
Option B (full unification): Switch to `entries.list({ type: 'saved' })`

Recommend Option A initially for backwards compatibility.

#### 3c. Add Entry Type Display (Optional Enhancement)

**File**: `src/components/articles/ArticleListItem.tsx`

Add visual indicator for entry type:

- Small icon or label showing source type (RSS, Email, Saved)
- Useful in unified views like "All Starred"

**Files to modify**:

- `src/lib/hooks/useSavedArticleMutations.ts`
- `src/lib/hooks/useEntryMutations.ts` (may need to consolidate)
- `src/components/saved/SavedArticleList.tsx` (optional)
- `src/components/articles/ArticleListItem.tsx` (optional)

### Phase 4: Android App - Migrate to Unified API

**Goal**: Update Android app to use unified `entries.*` endpoints.

#### 4a. Update Entry Models

**File**: `android/app/src/main/java/com/lionreader/data/api/models/EntryModels.kt`

Add type field:

```kotlin
@Serializable
data class EntryDto(
    // ... existing fields
    val type: EntryType,  // NEW
)

@Serializable
enum class EntryType {
    @SerialName("rss") RSS,
    @SerialName("email") EMAIL,
    @SerialName("saved") SAVED,
}
```

#### 4b. Update API Interface

**File**: `android/app/src/main/java/com/lionreader/data/api/LionReaderApi.kt`

Add type filter to getEntries:

```kotlin
suspend fun getEntries(
    // ... existing params
    type: EntryType? = null,
    excludeTypes: List<EntryType>? = null,
): ApiResult<EntriesResponse>
```

#### 4c. Migrate Saved Article Operations

Update SavedArticleRepository to use entries endpoints for mutations:

- `markRead` → `POST /entries/mark-read`
- `star` → `POST /entries/{id}/star`
- `unstar` → `DELETE /entries/{id}/star`

Keep using `/saved` for:

- `saveArticle` → `POST /saved` (unique save-from-URL logic)
- `deleteArticle` → `DELETE /saved/{id}` (hard delete)

#### 4d. Update API Contract Test

**File**: `android/app/src/test/java/com/lionreader/data/api/ApiContractTest.kt`

Update `clientPaths` to reflect any endpoint changes.

**Files to modify**:

- `android/app/src/main/java/com/lionreader/data/api/models/EntryModels.kt`
- `android/app/src/main/java/com/lionreader/data/api/LionReaderApi.kt`
- `android/app/src/main/java/com/lionreader/data/repository/SavedArticleRepository.kt`
- `android/app/src/test/java/com/lionreader/data/api/ApiContractTest.kt`

### Phase 5: Unified Starred View (Optional Enhancement)

**Goal**: Show all starred items (feeds + saved + email) in one unified view.

This already works with `entries.list({ starredOnly: true })` since the visibility rules include saved feeds. The main enhancement would be:

1. Add type indicator to distinguish sources in the list
2. Ensure mutations work correctly for all types
3. Update Android app's starred view similarly

---

## Implementation Order

1. **Phase 1**: Backend type filter (required foundation)
2. **Phase 3a-3b**: Web app mutation migration (can start immediately after Phase 1)
3. **Phase 4a-4d**: Android app migration (can run in parallel with Phase 3)
4. **Phase 2**: Deprecate old endpoints (after clients migrated)
5. **Phase 3c, Phase 5**: Optional UI enhancements (can be done anytime)

---

## Breaking Changes

**None** - All changes are backwards compatible:

- New `type` parameter is optional
- Deprecated endpoints continue to work
- Response schema additions are non-breaking

---

## Testing Plan

1. **Unit tests**: Add tests for type filtering in entries.list
2. **Integration tests**: Verify saved articles appear correctly with type filter
3. **Web app**: Manual testing of saved article operations
4. **Android app**: Run ApiContractTest, manual testing of saved articles
5. **Regression**: Ensure existing starred view continues to work

---

## Migration Timeline

- **Phase 1-2**: Single PR for backend changes
- **Phase 3**: Single PR for web app changes
- **Phase 4**: Single PR for Android app changes
- **Phase 5**: Optional follow-up PR

Each phase can be merged independently once tested.

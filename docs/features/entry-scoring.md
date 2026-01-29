# Entry Scoring System

The entry scoring system tracks user interest signals to help with future ranking and recommendations.

## Score Types

### Explicit Score (-2 to +2)

Users can manually vote on entries using up/down controls:

- **+2**: Strong upvote (double chevron up)
- **+1**: Upvote (single chevron up)
- **0**: Neutral (clears vote)
- **-1**: Downvote (single chevron down)
- **-2**: Strong downvote (double chevron down)

Explicit scores are stored in `user_entries.score` and take precedence over implicit scores for display.

### Implicit Score

Implicit scores are computed from user actions that indicate interest or disinterest. These are tracked via boolean flags in `user_entries`:

| Action                      | Flag                      | Implicit Score | Rationale                          |
| --------------------------- | ------------------------- | -------------- | ---------------------------------- |
| Star an entry               | `has_starred`             | +2             | Starring indicates strong interest |
| Mark unread (from anywhere) | `has_marked_unread`       | +1             | User wants to revisit this content |
| Mark read from entry list   | `has_marked_read_on_list` | -1             | Dismissed without opening          |
| Save an article             | Entry type = `saved`      | +1             | User explicitly chose to save it   |

**Priority order**: starred (+2) > unread (+1) > read-on-list (-1) > saved default (+1) > default (0)

### Display Score

The display score shown in the UI is: `explicit_score ?? implicit_score`

If the user has voted explicitly, that takes precedence. Otherwise, the implicit score is shown.

## Boolean Flag Behavior

**Flags are "sticky" - once set to `true`, they are never reset to `false`.**

This is intentional: the flags represent "has this user ever done this action" rather than current state. For example:

1. User stars an entry → `has_starred = true`, implicit = +2
2. User unstars the entry → `has_starred` remains `true`, implicit still +2
3. User then marks it read from list → `has_marked_read_on_list = true`, but implicit still +2 (starred takes priority)

The historical signal is preserved even if the user later changes their mind.

## Implementation

### Database Schema

```sql
-- In user_entries table
score smallint,                           -- Explicit score (-2 to +2), null = no vote
score_changed_at timestamptz,             -- When explicit score was last changed
has_marked_read_on_list boolean NOT NULL DEFAULT false,
has_marked_unread boolean NOT NULL DEFAULT false,
has_starred boolean NOT NULL DEFAULT false
```

### Computing Implicit Score

```typescript
// src/server/services/entries.ts
export function computeImplicitScore(
  hasStarred: boolean,
  hasMarkedUnread: boolean,
  hasMarkedReadOnList: boolean,
  type?: "web" | "email" | "saved"
): number {
  if (hasStarred) return 2;
  if (hasMarkedUnread) return 1;
  if (hasMarkedReadOnList) return -1;
  if (type === "saved") return 1; // Saved articles default to +1
  return 0;
}
```

### Setting Implicit Flags

Flags are set in the relevant mutations:

- **`has_starred`**: Set in `entries.star` mutation when starring
- **`has_marked_unread`**: Set in `entries.markRead` when `read = false`
- **`has_marked_read_on_list`**: Set in `entries.markRead` when `read = true` AND `fromList = true`

The `fromList` parameter is passed by the frontend when the mark-read action originates from the entry list (not from within the entry view).

## UI Components

### VoteControls

Located at `src/components/entries/VoteControls.tsx`:

- Vertical layout: up arrow → score → down arrow
- Single chevrons for +1/-1, double chevrons for +2/-2
- Colors: green for positive, red for negative, gray for neutral
- Clicking cycles through scores (up: 0→1→2→0, down: 0→-1→-2→0)

### Positioning

Vote controls appear to the right of the entry title in `EntryContentBody.tsx`, with the score number aligned to the first line of the title.

## Future Use

The scoring data can be used for:

1. **Personalized ranking**: Sort entries by predicted interest
2. **Feed recommendations**: Suggest feeds similar to highly-scored entries
3. **Smart filtering**: Hide entries likely to be dismissed
4. **Training ML models**: Use explicit/implicit scores as training labels

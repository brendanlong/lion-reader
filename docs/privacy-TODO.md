# Privacy Feature TODO

This document tracks privacy-related features that are mentioned in the privacy policy but not yet fully implemented, or that would enhance user privacy controls.

## Missing Features

### 1. Account Deletion (Self-Service)

**Status:** Not implemented
**Priority:** High
**Impact:** Users currently must contact us to delete their account

**Requirements:**
- Add "Delete Account" button in account settings
- Implement tRPC endpoint: `users.deleteAccount`
- Hard delete user data:
  - User record (cascades to sessions, oauth_accounts)
  - Subscriptions (user_entry_states, subscriptions)
  - Saved articles
  - User-specific narration preferences
- Soft delete or anonymize data that can't be fully deleted:
  - Keep shared feed/entry data (other users may still be subscribed)
  - Optional: anonymize or delete error logs containing user context
- Show confirmation dialog with warnings:
  - "This action is permanent and cannot be undone"
  - "Your feed subscriptions and reading history will be deleted"
  - "Saved articles will be permanently removed"
- Require password confirmation or re-authentication
- Immediately revoke all sessions and log user out
- Optional: Send confirmation email before deletion (with 24-hour grace period)

**Files to modify:**
- `src/server/trpc/routers/users.ts` - Add deleteAccount mutation
- `src/app/(app)/settings/page.tsx` - Add delete account UI
- `src/server/db/queries/users.ts` - Add deletion logic

### 2. Full Data Export (JSON)

**Status:** Partial (OPML only)
**Priority:** Medium
**Impact:** Users can export subscriptions but not reading history, saved articles, or settings

**Requirements:**
- Implement tRPC endpoint: `users.exportData`
- Export format: JSON file containing:
  - Account info (email, created_at)
  - Feed subscriptions (with custom titles, folders)
  - Reading history (which entries read/starred, timestamps)
  - Saved articles (full content, metadata)
  - Settings/preferences (narration settings, view preferences)
  - Active sessions (excluding sensitive tokens)
- Download as `lion-reader-data-YYYY-MM-DD.json`
- Consider pagination/streaming for large exports
- Optional: separate exports for different data types (subscriptions, saved articles, history)

**Files to modify:**
- `src/server/trpc/routers/users.ts` - Add exportData query
- `src/app/(app)/settings/page.tsx` - Add export button to settings

### 3. Saved Articles Export

**Status:** Not implemented
**Priority:** Medium
**Impact:** Users cannot export their saved articles separately

**Requirements:**
- Add export button in saved articles view
- Export formats:
  - JSON (full data including content)
  - HTML (readable archive)
  - Markdown (for import to other tools)
- Include article URL, title, content, saved date, read/starred status

**Files to modify:**
- `src/server/trpc/routers/saved.ts` - Add export query
- `src/app/(app)/saved/page.tsx` - Add export UI

## Privacy Enhancements (Not in Policy Yet)

These features would improve privacy but are not required by the current policy.

### 4. Narration Cache Deletion

**Status:** Not implemented
**Priority:** Low
**Impact:** Users cannot delete cached narration text

**Requirements:**
- Add setting to clear all narration cache for user's articles
- Show storage usage (how much narration text is cached)
- Clear button: "Clear all cached narration text"
- Note: Only deletes cache entries where user is the only one who accessed them
  (shared cache entries remain for other users)

### 5. Session Management Improvements

**Status:** Partial (can revoke sessions)
**Priority:** Low
**Impact:** Better visibility into active sessions

**Enhancements:**
- Show more session details:
  - Last active timestamp
  - Browser/OS detection from user agent
  - Approximate location from IP (city/country level)
- "Revoke all other sessions" button (keep current session only)
- Email notification when new session is created from unknown device/location

### 6. Privacy Dashboard

**Status:** Not implemented
**Priority:** Low
**Impact:** Centralized view of privacy settings and data

**Requirements:**
- New page: `/settings/privacy`
- Show at a glance:
  - What data we have (subscriptions count, saved articles count, sessions count)
  - Active third-party integrations (OAuth connections, which are active)
  - Optional features status (AI narration: enabled/disabled)
  - Data exports (download history, last export date)
- Quick actions:
  - Export all data
  - Revoke all OAuth connections
  - Clear narration cache
  - Delete account

### 7. Consent Management for Groq

**Status:** Partial (setting exists)
**Priority:** Low
**Impact:** More explicit consent flow

**Enhancements:**
- First-time use dialog when enabling AI narration:
  - "Article content will be sent to Groq for processing"
  - Link to Groq privacy policy
  - Checkbox: "I understand and agree"
- Show indicator in narration UI when AI processing is active
- Keep log of which articles were sent to Groq (for transparency)

### 8. Anonymize/Delete Old Logs

**Status:** Not implemented
**Priority:** Low
**Impact:** Currently logs retained for 30 days

**Requirements:**
- Automated job to delete logs older than 30 days
- For error reports in Sentry: scrub user identifiers before sending
- Consider anonymizing rather than deleting (hash user IDs, remove IP addresses)

## Testing Requirements

When implementing deletion features, ensure:
- Integration tests for complete data deletion
- Verify cascade deletes work correctly
- Test that shared data (feeds, entries) is NOT deleted when one user deletes account
- Verify sessions are immediately invalidated
- Test GDPR compliance (if expanding to EU)

## Documentation Updates

After implementing each feature:
- Update privacy policy (src/app/privacy/page.tsx)
- Update this TODO (mark as complete)
- Add to changelog
- Update user documentation/help pages

## Timeline

**Phase 1 (High Priority):**
- Account deletion (self-service)

**Phase 2 (Medium Priority):**
- Full data export (JSON)
- Saved articles export

**Phase 3 (Nice to Have):**
- Privacy dashboard
- Session management improvements
- Consent management for Groq

# Google Docs Custom Backend Design

## Overview

This document describes adding a custom backend for saving Google Docs articles, similar to the existing LessWrong backend. When users save a Google Docs URL via the bookmarklet or save flow, Lion Reader will fetch the content using the Google Docs API instead of HTML scraping, resulting in cleaner, better-formatted content that respects document permissions.

## Motivation

**Problem**: Google Docs URLs don't work well with standard HTML fetching:

- Rendered HTML is heavily JavaScript-dependent
- Exported HTML contains Google-specific markup and formatting
- Server-side fetching gets incomplete/malformed content
- No respect for document permissions (private vs public)

**Solution**: Use Google Docs API to fetch structured document content and convert it to clean HTML, similar to how the LessWrong backend uses their GraphQL API.

## Current State

### Existing Custom Backend Pattern

**LessWrong Backend** (`src/server/feed/lesswrong.ts`):

- URL detection via regex pattern matching
- API-based content fetching (GraphQL)
- Fallback to standard HTML fetch on failure
- Integration in `saved.ts` via if/else branching

**OAuth Infrastructure** (`src/server/auth/oauth/`):

- Google OAuth already implemented for sign-in
- Uses `arctic` library for OAuth flows
- Tokens stored in `oauth_accounts` table
- Current scopes: `["openid", "email", "profile"]` (identity only)

### Current Saved Article Flow

```
User saves URL
    ↓
saved.save mutation (src/server/trpc/routers/saved.ts:270-334)
    ↓
if (isLessWrongUrl(url))
    Try LessWrong GraphQL API
    Fall back to HTML fetch
else
    Standard HTML fetch
    ↓
Extract metadata (og:tags, meta tags)
    ↓
Run Readability for clean content
    ↓
Store in entries table (type='saved', guid=URL)
```

## Proposed Design

### Phase 1: Public Documents Only (Initial Implementation)

**Scope**: Support public Google Docs using a server-side service account.

**Prerequisites**:

- `GOOGLE_SERVICE_ACCOUNT_JSON` environment variable configured (base64-encoded JSON key)
- Google Cloud project with "Google Docs API" enabled

**Note**: The Google Docs API requires OAuth2 tokens - API keys are not supported.
A service account provides server-side access to publicly shared documents without
requiring per-user OAuth tokens. The service account credentials are used to obtain
access tokens via the `google-auth-library`.

**Detection**:

```typescript
// src/server/google/docs.ts
export function isGoogleDocsUrl(url: string): boolean;
export function extractDocId(url: string): string | null;

// Matches:
// - https://docs.google.com/document/d/DOCUMENT_ID/edit
// - https://docs.google.com/document/d/DOCUMENT_ID/
// - Supports /pub, /preview, /edit variants
const GOOGLE_DOCS_URL_PATTERN = /^https?:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/;
```

**Fetching Public Documents**:

```typescript
interface GoogleDocsContent {
  title: string;
  html: string; // Converted from Docs API structure
  author: string | null;
  createdAt: Date | null;
  modifiedAt: Date | null;
}

async function fetchPublicGoogleDoc(docId: string): Promise<GoogleDocsContent | null> {
  // Requires service account credentials
  if (!googleConfig.serviceAccountJson) {
    return null; // Not configured, fall back to HTML scraping
  }

  // Get access token from service account
  const accessToken = await getServiceAccountAccessToken();
  if (!accessToken) {
    return null;
  }

  // Use Google Docs API v1 with OAuth2 Bearer token
  // GET https://docs.googleapis.com/v1/documents/{documentId}
  const response = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    return null; // Not public or doesn't exist
  }

  const doc = await response.json();
  return convertDocsApiToHtml(doc);
}
```

**Content Conversion**:
The Google Docs API returns structured JSON representing the document's content:

```json
{
  "title": "Document Title",
  "body": {
    "content": [
      {
        "paragraph": {
          "elements": [
            {"textRun": {"content": "Hello world", "textStyle": {...}}}
          ],
          "paragraphStyle": {...}
        }
      }
    ]
  }
}
```

Convert to clean HTML:

```typescript
function convertDocsApiToHtml(doc: GoogleDocsApiDocument): string {
  // Walk document structure
  // Convert paragraphs → <p>
  // Convert headings → <h1>, <h2>, etc.
  // Convert lists → <ul>, <ol>
  // Convert text styles (bold/italic) → <strong>, <em>
  // Convert links → <a href="...">
  // Preserve tables, images

  return cleanHtml;
}
```

**Integration**:

```typescript
// In src/server/trpc/routers/saved.ts (around line 281)
if (input.html) {
  html = input.html;
} else if (isGoogleDocsUrl(input.url)) {
  const docId = extractDocId(input.url);
  if (docId) {
    const googleDocsContent = await fetchPublicGoogleDoc(docId);
    if (googleDocsContent) {
      html = wrapContentInHtml(googleDocsContent);
    } else {
      // Fall back to standard HTML fetch
      html = await fetchPage(input.url);
    }
  } else {
    html = await fetchPage(input.url);
  }
} else if (isLessWrongUrl(input.url)) {
  // ... existing LessWrong logic
} else {
  html = await fetchPage(input.url);
}
```

### Phase 2: Private Documents with Incremental OAuth (Future)

**Goal**: Support private Google Docs by requesting additional OAuth scope only when needed.

**New OAuth Scope Required**:

```typescript
const GOOGLE_DOCS_READONLY_SCOPE = "https://www.googleapis.com/auth/documents.readonly";
```

**Database Schema Addition**:

```sql
-- Track which OAuth scopes user has granted
ALTER TABLE oauth_accounts ADD COLUMN scopes text[];

-- Index for scope lookups
CREATE INDEX idx_oauth_accounts_scopes ON oauth_accounts USING GIN (scopes);
```

**Incremental Authorization Flow**:

1. **User tries to save private Google Doc**

   ```typescript
   // Detect it's a Google Doc
   if (isGoogleDocsUrl(input.url)) {
     // Try public access first
     const publicContent = await fetchPublicGoogleDoc(docId);
     if (publicContent) {
       return publicContent; // Success!
     }

     // Document is private, check if user has Google OAuth
     const googleOAuth = await getOAuthAccount(ctx.user.id, "google");
     if (!googleOAuth) {
       throw new TRPCError({
         code: "UNAUTHORIZED",
         message: "Sign in with Google to access private documents",
       });
     }

     // Check if user has granted Docs permission
     const hasDocsScope = googleOAuth.scopes?.includes(GOOGLE_DOCS_READONLY_SCOPE);
     if (!hasDocsScope) {
       throw new TRPCError({
         code: "FORBIDDEN",
         message: "NEEDS_DOCS_PERMISSION",
         // Frontend shows "Grant access to Google Docs" button
       });
     }

     // Fetch with user's OAuth token
     const token = await getValidGoogleToken(ctx.user.id);
     return await fetchPrivateGoogleDoc(docId, token);
   }
   ```

2. **Frontend shows permission prompt**

   ```typescript
   // User sees:
   // "This is a private Google Doc. Grant Lion Reader access to read your Google Docs?"
   // [Grant Access] [Cancel]

   // Clicking "Grant Access" triggers:
   await trpc.auth.requestGoogleDocsAccess.mutate();
   ```

3. **Incremental authorization endpoint**

   ```typescript
   // src/server/trpc/routers/auth.ts
   requestGoogleDocsAccess: protectedProcedure.mutation(async ({ ctx }) => {
     // Generate OAuth URL with BOTH existing + new scopes
     const existingScopes = ["openid", "email", "profile"];
     const newScopes = [GOOGLE_DOCS_READONLY_SCOPE];
     const allScopes = [...existingScopes, ...newScopes];

     const authUrl = await google.createAuthorizationURL({
       state: generateState(),
       scopes: allScopes,
     });

     return { authUrl };
   });
   ```

4. **OAuth callback updates scopes**

   ```typescript
   // After user consents, update oauth_accounts
   await db
     .update(oauthAccounts)
     .set({
       accessToken: newTokens.accessToken,
       refreshToken: newTokens.refreshToken,
       expiresAt: newTokens.expiresAt,
       scopes: allScopes, // Update with new scopes
     })
     .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "google")));
   ```

5. **Retry save with new permissions**
   Frontend automatically retries the save mutation after OAuth completes.

**Token Refresh Implementation**:

```typescript
// src/server/google/tokens.ts
async function getValidGoogleToken(userId: string): Promise<string> {
  const oauth = await db.query.oauthAccounts.findFirst({
    where: and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "google")),
  });

  if (!oauth) {
    throw new Error("No Google OAuth account linked");
  }

  // Check if token is expired or about to expire (5 min buffer)
  const expiresIn = oauth.expiresAt ? (oauth.expiresAt.getTime() - Date.now()) / 1000 : 0;

  if (expiresIn > 300) {
    // Token still valid
    return oauth.accessToken!;
  }

  // Token expired, refresh it
  if (!oauth.refreshToken) {
    throw new Error("No refresh token available");
  }

  const google = new Google({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectURI: `${env.BASE_URL}/api/auth/google/callback`,
  });

  const tokens = await google.refreshAccessToken(oauth.refreshToken);

  // Update stored tokens
  await db
    .update(oauthAccounts)
    .set({
      accessToken: tokens.accessToken,
      expiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
      // refreshToken may be rotated
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    })
    .where(eq(oauthAccounts.id, oauth.id));

  return tokens.accessToken;
}
```

**Private Document Fetching**:

```typescript
async function fetchPrivateGoogleDoc(
  docId: string,
  accessToken: string
): Promise<GoogleDocsContent | null> {
  const response = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Google token invalid or expired",
      });
    }
    if (response.status === 403) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No permission to access this document",
      });
    }
    return null;
  }

  const doc = await response.json();
  return convertDocsApiToHtml(doc);
}
```

## File Structure

```
src/
  server/
    google/
      docs.ts          # Google Docs API integration
      tokens.ts        # Token refresh utilities (Phase 2)
    trpc/routers/
      saved.ts         # Add Google Docs detection/fetching
      auth.ts          # Add incremental auth endpoint (Phase 2)

tests/
  unit/
    google-docs.test.ts         # URL detection, conversion logic
  integration/
    google-docs-save.test.ts    # Full save flow with mocked API
```

## API Considerations

### Rate Limits

**Google Docs API Quotas** (free tier):

- 300 requests per minute per project
- 60 requests per minute per user

**Mitigation**:

- Cache converted content using existing content_hash mechanism
- Only fetch when URL is saved (not on preview)
- Use exponential backoff on quota errors

### Error Handling

```typescript
try {
  const content = await fetchGoogleDoc(docId, token);
} catch (error) {
  if (error.code === "QUOTA_EXCEEDED") {
    // Log and fall back to HTML fetch
    logger.warn("Google Docs API quota exceeded", { docId });
    return await fetchPage(input.url);
  }

  if (error.code === "FORBIDDEN") {
    // User doesn't have access to doc
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have permission to access this document",
    });
  }

  // Other errors: fall back to HTML fetch
  return await fetchPage(input.url);
}
```

## User Experience Flows

### Flow 1: Saving Public Google Doc (Phase 1)

```
1. User clicks bookmarklet on public Google Doc
2. Save dialog opens
3. Backend detects Google Docs URL
4. If GOOGLE_SERVICE_ACCOUNT_JSON configured, fetches content via Docs API
5. Converts structured content to clean HTML
6. Saves as normal saved article
7. Success notification
```

**Fallbacks**:

- If `GOOGLE_SERVICE_ACCOUNT_JSON` not configured: falls back to standard HTML fetch
- If API call fails (doc is private or restricted): falls back to standard HTML fetch

### Flow 2: Saving Private Google Doc (Phase 2)

#### First Time (Needs Permission)

```
1. User clicks bookmarklet on private Google Doc
2. Save dialog opens
3. Backend detects Google Docs URL
4. Tries public API → 403 Forbidden
5. Checks if user has Google OAuth → Yes
6. Checks if user has Docs scope → No
7. Returns error: NEEDS_DOCS_PERMISSION
8. Frontend shows:
   "This is a private Google Doc. Grant access to read your Google Docs?"
   [Grant Access] [Cancel]
9. User clicks "Grant Access"
10. OAuth popup → Google consent screen
    "Lion Reader wants to view your Google Docs"
11. User approves
12. OAuth callback updates scopes in database
13. Frontend auto-retries save
14. Backend fetches with user's token
15. Success!
```

#### Subsequent Saves

```
1. User saves another private Google Doc
2. Backend has valid token with Docs scope
3. Fetches directly with user's token
4. Success!
```

### Flow 3: User Not Signed in with Google (Phase 2)

```
1. User (signed in with email/password) tries to save private Google Doc
2. Backend detects Google Docs URL
3. Tries public API → 403 Forbidden
4. No Google OAuth account found
5. Returns error with message:
   "Sign in with Google to access private documents"
6. User can either:
   a) Link their Google account in settings
   b) Save as regular HTML (fallback)
```

## Database Schema Changes

### Phase 1: None Required

Phase 1 uses only public API, no new database fields needed.

### Phase 2: Add Scopes Column

```sql
-- Migration: Add scopes tracking to oauth_accounts
ALTER TABLE oauth_accounts ADD COLUMN scopes text[];

-- Create GIN index for efficient scope lookups
CREATE INDEX idx_oauth_accounts_scopes ON oauth_accounts USING GIN (scopes);

-- Populate existing Google OAuth accounts with current scopes
UPDATE oauth_accounts
SET scopes = ARRAY['openid', 'email', 'profile']
WHERE provider = 'google' AND scopes IS NULL;
```

## Implementation Plan

### Phase 1: Public Documents (Initial PR)

1. ✅ **Design doc** (this document)

2. **Implementation**:
   - ✅ Create `src/server/google/docs.ts`
     - `isGoogleDocsUrl()`
     - `extractDocId()`
     - `fetchPublicGoogleDoc()` (uses service account credentials)
     - `convertDocsApiToHtml()` (basic conversion)
   - ✅ Add `google-auth-library` dependency for service account auth
   - ✅ Add `GOOGLE_SERVICE_ACCOUNT_JSON` to environment configuration
     - `src/server/config/env.ts` - googleConfig
     - `.env.example` - documentation for setup (base64-encoded JSON key)
   - ✅ Update `src/server/trpc/routers/saved.ts`
     - Add Google Docs detection in save mutation
     - Add fallback logic
   - ✅ Add unit tests (`tests/unit/google-docs.test.ts`)
     - URL pattern matching
     - Doc ID extraction
     - HTML conversion logic
   - [ ] Add integration tests (`tests/integration/google-docs-save.test.ts`)
     - Mock Google Docs API responses
     - Test full save flow
     - Test fallback behavior

3. **Testing**:
   - [ ] Manual test with various public Google Docs
   - [ ] Verify fallback works for private docs
   - [ ] Verify content quality vs HTML scraping

4. **Documentation**:
   - ✅ Update design doc with API key requirement

### Phase 2: Private Documents with OAuth (Future PR)

**Estimated effort**: 3-4 days

**Prerequisites**: Phase 1 merged and tested in production

1. **Database Migration**:
   - [ ] Add `scopes` column to `oauth_accounts`
   - [ ] Create migration file
   - [ ] Test migration on staging

2. **Token Management**:
   - [ ] Create `src/server/google/tokens.ts`
     - `getValidGoogleToken()` with auto-refresh
     - `refreshGoogleToken()`
   - [ ] Add token refresh tests

3. **Incremental Authorization**:
   - [ ] Add `requestGoogleDocsAccess` mutation to auth router
   - [ ] Update OAuth callback to handle scope updates
   - [ ] Update Google OAuth flow to merge scopes

4. **Private Document Support**:
   - [ ] Add `fetchPrivateGoogleDoc()` to `docs.ts`
   - [ ] Update save mutation to handle OAuth flow
   - [ ] Add error codes for permission states

5. **Frontend**:
   - [ ] Add permission request UI
   - [ ] Handle NEEDS_DOCS_PERMISSION error
   - [ ] Auto-retry after OAuth grant
   - [ ] Update settings to show Google Docs permission

6. **Testing**:
   - [ ] Integration tests with mocked OAuth
   - [ ] Test token refresh logic
   - [ ] Test incremental authorization flow
   - [ ] Manual testing with real Google account

## Benefits

### Compared to HTML Scraping

1. **Better Content Quality**:
   - Clean, semantic HTML from structured document data
   - No Google Docs UI chrome or navigation
   - Proper heading hierarchy
   - Preserved formatting (bold, italic, lists, tables)

2. **Respects Permissions**:
   - Only accesses docs user has permission to read
   - Graceful handling of permission denied
   - Works with organization/domain-restricted docs (with user's OAuth)

3. **More Reliable**:
   - No dependence on rendered HTML structure
   - No JavaScript execution required
   - Consistent API response format

4. **Future-Proof**:
   - API is more stable than HTML structure
   - Documented and versioned (currently v1)

### Compared to LessWrong Backend

**Similarities**:

- URL-based detection
- API-first with HTML fallback
- Clean content extraction
- Same integration pattern

**Differences**:

- Google Docs requires OAuth for private docs (LessWrong is all public)
- More complex permission model
- Need token refresh logic
- Incremental authorization UX

## Risks and Mitigations

| Risk                               | Impact                            | Mitigation                                         |
| ---------------------------------- | --------------------------------- | -------------------------------------------------- |
| **Google API quota exceeded**      | Users can't save docs             | Fall back to HTML fetch, log for monitoring        |
| **Token refresh fails**            | Private docs stop working         | Clear error message, prompt to re-auth             |
| **API structure changes**          | Conversion breaks                 | Comprehensive tests, version detection, fallback   |
| **Scope creep in OAuth**           | Users concerned about permissions | Only request readonly, clear UX about why          |
| **Private doc without permission** | Confusing error                   | Clear messaging, offer to sign in with Google      |
| **HTML conversion quality**        | Missing formatting                | Iterate on conversion logic, compare with scraping |

## Alternatives Considered

### Alternative 1: Use Google Docs Export API

Google provides an export endpoint that returns HTML directly:

```
GET /export?format=html
```

**Pros**: No conversion logic needed
**Cons**:

- Export HTML is messy (Google-specific classes, inline styles)
- Still requires OAuth for private docs
- Less control over output quality

**Decision**: Use structured API for cleaner output

### Alternative 2: Request Docs Scope During Initial Sign-In

Add Docs scope to the initial OAuth request.

**Pros**: Simpler implementation, no incremental auth
**Cons**:

- Adds friction to sign-in flow
- Most users won't need it
- Google recommends incremental authorization
- Higher permission request scares users

**Decision**: Use incremental authorization (Phase 2)

### Alternative 3: Always Fall Back to HTML Scraping

Don't use Google Docs API at all.

**Pros**: No OAuth complexity
**Cons**:

- Poor content quality
- Doesn't respect permissions
- Unreliable (JS-dependent rendering)

**Decision**: Implement API-based approach for better UX

## Future Enhancements

### Support for Other Google Docs Types

**Scope**: Extend to Sheets, Slides, Forms

```typescript
// Detect all Docs types
export function isGoogleDocsUrl(url: string): GoogleDocsType | null {
  if (url.includes("/document/")) return "document";
  if (url.includes("/spreadsheets/")) return "spreadsheet";
  if (url.includes("/presentation/")) return "presentation";
  if (url.includes("/forms/")) return "form";
  return null;
}
```

**Challenges**:

- Different API endpoints and response formats
- Sheets/Slides may not convert well to article format
- Forms are interactive, not content

**Recommendation**: Start with Documents only, evaluate others based on user demand.

### Document Update Detection

**Scope**: Detect when saved Google Docs have been edited

**Implementation**:

- Store `revisionId` from API response
- Periodically check for updates (like feed polling)
- Notify user or auto-update saved copy

**Challenges**:

- Requires ongoing API calls (quota usage)
- Need background job infrastructure
- User expectation: saved = snapshot, not live

**Recommendation**: Not in initial scope, consider for future.

### Shared Document Deduplication

**Scope**: Multiple users saving the same public doc

**Implementation**:

- Hash public doc URL
- Deduplicate entries like RSS feed entries
- Share single entry across users

**Challenges**:

- Current saved articles are per-user (type='saved', user_id set)
- Would need to treat public docs like shared feed
- Mixed model: public shared, private per-user

**Recommendation**: Consider after observing usage patterns.

## Success Metrics

### Phase 1 Success Criteria

- [ ] Public Google Docs save successfully 90%+ of the time
- [ ] Content quality visibly better than HTML scraping
- [ ] Zero regression in non-Google-Docs saves
- [ ] API quota usage under 50% of free tier limit
- [ ] Fallback works for private/restricted docs

### Phase 2 Success Criteria

- [ ] Users can save private docs they have access to
- [ ] OAuth grant rate >70% when prompted
- [ ] Token refresh succeeds >95% of time
- [ ] Clear error messages for permission issues
- [ ] No user complaints about excessive permissions

## References

- [Google Docs API Documentation](https://developers.google.com/docs/api)
- [Google Docs API v1 Reference](https://developers.google.com/docs/api/reference/rest)
- [Google OAuth 2.0 Scopes](https://developers.google.com/identity/protocols/oauth2/scopes#docs)
- [Incremental Authorization](https://developers.google.com/identity/protocols/oauth2/web-server#incrementalAuth)
- [LessWrong Backend Implementation](../../src/server/feed/lesswrong.ts)
- [Google OAuth Implementation](../../src/server/auth/oauth/google.ts)

# GitHub Gist & File Plugin Design

## Overview

This document describes adding a plugin to save GitHub Gists and repository files as saved articles. The plugin detects GitHub URLs and fetches content via the GitHub API (for gists) or raw content URLs (for repo files), with automatic Markdown-to-HTML conversion.

## Motivation

**Problem**: GitHub Gists and repo files are commonly used to share:

- Code snippets and tutorials
- Markdown documentation
- Configuration files
- Blog posts written in Markdown

Users want to save these for later reading, but standard HTML scraping produces poor results due to GitHub's JavaScript-heavy interface.

**Solution**: Use the GitHub API for gists and raw content URLs for repo files, converting Markdown to HTML for readable articles.

## URL Patterns Supported

| Pattern            | Example                                            | Handling                               |
| ------------------ | -------------------------------------------------- | -------------------------------------- |
| Gist page          | `gist.github.com/user/abc123`                      | Fetch via Gists API, concatenate files |
| Gist with fragment | `gist.github.com/user/abc123#file-readme-md`       | Fetch specific file from gist          |
| Anonymous gist     | `gist.github.com/abc123`                           | Fetch via Gists API                    |
| Repo root          | `github.com/user/repo`                             | Fetch README.md via Contents API       |
| Blob view          | `github.com/user/repo/blob/main/docs/guide.md`     | Fetch raw file content                 |
| Raw URL            | `raw.githubusercontent.com/user/repo/main/file.md` | Fetch directly                         |

## API Details

### Gists API

**Endpoint**: `GET https://api.github.com/gists/{gist_id}`

**Authentication**: Optional but recommended

- Unauthenticated: 60 requests/hour
- With token: 5,000 requests/hour

**Response structure** (relevant fields):

```json
{
  "id": "abc123",
  "description": "My gist description",
  "owner": { "login": "username" },
  "files": {
    "example.md": {
      "filename": "example.md",
      "language": "Markdown",
      "content": "# Hello\n\nWorld"
    },
    "script.py": {
      "filename": "script.py",
      "language": "Python",
      "content": "print('hello')"
    }
  },
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T12:00:00Z"
}
```

### Contents API (for repo files)

**Endpoint**: `GET https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={branch}`

**Response**: Returns file metadata and base64-encoded content.

### Raw Content URLs

**Pattern**: `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}`

**No authentication supported** on raw URLs - rate limited by IP.

## File Type Detection

Priority order:

1. **File extension**: `.md`, `.markdown` → Markdown; `.html`, `.htm` → HTML
2. **API language field**: Gists API returns `"language": "Markdown"` per file
3. **Content sniffing** (fallback): Check for `<!DOCTYPE html>` or Markdown patterns

## Multi-File Gist Handling

When a gist contains multiple files:

1. **With URL fragment** (e.g., `#file-readme-md`):
   - Extract filename from fragment (GitHub normalizes: `README.md` → `file-readme-md`)
   - Return only that file

2. **Without fragment**:
   - Concatenate all files in alphabetical order
   - Add file headers (`<h2>filename</h2>`) between files
   - Prioritize Markdown/text files over binary

## Implementation

### Plugin Structure

```typescript
// src/server/plugins/github.ts
export const githubPlugin: UrlPlugin = {
  name: "github",
  hosts: ["gist.github.com", "github.com", "raw.githubusercontent.com"],

  matchUrl(url: URL): boolean {
    // Match gists, repo roots, blob views, raw files
  },

  capabilities: {
    savedArticle: {
      async fetchContent(url: URL): Promise<SavedArticleContent | null> {
        // Detect URL type and fetch appropriately
      },
      skipReadability: true, // Our Markdown conversion is clean
      siteName: "GitHub",
    },
  },
};
```

### URL Type Detection

```typescript
type GitHubUrlType =
  | { type: "gist"; gistId: string; filename?: string }
  | { type: "repo-root"; owner: string; repo: string }
  | { type: "blob"; owner: string; repo: string; ref: string; path: string }
  | { type: "raw"; owner: string; repo: string; ref: string; path: string };
```

### Content Processing

1. **Gists**: Fetch via API, get all files, convert Markdown → HTML
2. **Repo root**: Fetch `README.md` (try common variants: `readme.md`, `README`, etc.)
3. **Blob/Raw**: Fetch raw content, convert if Markdown

### Markdown Conversion

Use `marked` library (already a dependency):

```typescript
import { marked } from "marked";

function markdownToHtml(content: string, filename: string): string {
  // Add syntax highlighting hints for code blocks
  // Convert relative links to absolute GitHub links
  return marked.parse(content);
}
```

## Configuration

### Environment Variable

```typescript
// src/server/config/env.ts
export const githubConfig = {
  /**
   * GitHub API token for improved rate limits (optional).
   *
   * Without token: 60 requests/hour
   * With token: 5,000 requests/hour
   *
   * Create a token at: https://github.com/settings/tokens
   * No scopes required for public repos/gists (fine-grained token with no permissions works).
   */
  apiToken: process.env.GITHUB_API_TOKEN,
};
```

### .env.example

```bash
# GitHub API token for saved articles plugin (optional)
# Improves rate limits from 60/hour to 5,000/hour
# Create at: https://github.com/settings/tokens (no scopes needed)
GITHUB_API_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

## Error Handling

| Scenario                           | Handling                                |
| ---------------------------------- | --------------------------------------- |
| Gist not found (404)               | Return null, fall back to HTML scraping |
| Private gist (404 unauthenticated) | Return null, fall back to HTML scraping |
| Rate limited (403/429)             | Log warning, return null, fall back     |
| Network error                      | Log warning, return null, fall back     |
| Invalid Markdown                   | Return as plain text in `<pre>`         |

## Future: GitHub OAuth for Private Content

**Not implemented in this PR**, but the architecture supports adding OAuth later.

### Potential Flow

1. User tries to save private gist
2. API returns 404 (or 403 for private repos)
3. Check if user has GitHub OAuth linked
4. If no OAuth: "Sign in with GitHub to access private content"
5. If OAuth but no `gist` scope: Incremental authorization
6. Retry with user's token

### OAuth Scopes Needed

- `gist` - Read private gists
- `repo` - Read private repositories (broader, may want to avoid)

### Database Changes (Future)

Would require storing GitHub OAuth tokens in `oauth_accounts` table, similar to Google OAuth.

## Testing

### Unit Tests

- URL pattern matching for all supported formats
- Gist ID extraction
- Filename fragment parsing (GitHub's normalization: `README.md` → `file-readme-md`)
- Markdown detection logic
- Multi-file concatenation

### Manual Testing

- Public gist with single Markdown file
- Public gist with multiple files
- Gist with URL fragment targeting specific file
- Repo root (should fetch README)
- Repo blob view (specific file)
- Raw URL
- Non-existent gist (should fall back)

## File Structure

```
src/server/
  config/
    env.ts                    # Add githubConfig
  plugins/
    github.ts                 # New plugin
    index.ts                  # Register plugin
tests/unit/
  github-plugin.test.ts       # URL matching, content processing
```

## Implementation Checklist

- [x] Design doc (this document)
- [ ] Add `githubConfig` to env.ts
- [ ] Create `src/server/plugins/github.ts`
- [ ] Register plugin in `src/server/plugins/index.ts`
- [ ] Add unit tests
- [ ] Manual testing
- [ ] Update .env.example

## References

- [GitHub REST API - Gists](https://docs.github.com/en/rest/gists/gists)
- [GitHub REST API - Contents](https://docs.github.com/en/rest/repos/contents)
- [GitHub Rate Limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [marked library](https://marked.js.org/)

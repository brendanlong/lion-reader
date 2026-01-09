# Google Drive Export Plan

## Overview

Replace the current Google Docs API implementation (~1000 lines of manual JSON-to-HTML conversion) with a simpler approach using the Google Drive API.

## Current State

- `src/server/google/docs.ts` fetches documents via Google Docs API (`docs.googleapis.com/v1/documents`)
- Manually converts structured document JSON to HTML (paragraphs, lists, tables, footnotes, images, etc.)
- Only works for **native Google Docs** - fails with "This operation is not supported for this document" for uploaded .docx files

## Proposed Approach

### 1. Check File Type First

Use Drive API to get file metadata:

```
GET https://www.googleapis.com/drive/v3/files/{fileId}?fields=name,mimeType
```

### 2. Branch Based on MIME Type

| MIME Type                                                                 | File Type         | Approach                        |
| ------------------------------------------------------------------------- | ----------------- | ------------------------------- |
| `application/vnd.google-apps.document`                                    | Native Google Doc | `files.export` → HTML           |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | Uploaded .docx    | `files.get?alt=media` → mammoth |

### 3. Native Google Docs: files.export

```
GET https://www.googleapis.com/drive/v3/files/{fileId}/export?mimeType=text/html
```

- Google converts to HTML for us
- Returns complete HTML directly
- No manual conversion needed

### 4. Uploaded .docx: Download + Mammoth

```
GET https://www.googleapis.com/drive/v3/files/{fileId}?alt=media
```

- Downloads raw .docx bytes
- Parse in-memory with `mammoth` library
- Configure style mappings for Title/Subtitle → h1/h2

```javascript
const styleMap = ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"];
const result = await mammoth.convertToHtml({ buffer }, { styleMap });
```

## Files to Change

1. **Delete**: Most of `src/server/google/docs.ts` (keep URL parsing utilities)
2. **Create**: `src/server/google/drive.ts` - new Drive API implementation
3. **Update**: `src/server/trpc/routers/saved.ts` - use new module
4. **Update**: `src/server/config/env.ts` - if any new config needed

## OAuth Scope

- Current: `https://www.googleapis.com/auth/documents.readonly`
- New: `https://www.googleapis.com/auth/drive.readonly`

The service account already has Drive API enabled. For user OAuth (future), we'd request `drive.readonly` scope progressively when the feature is first used.

## Benefits

1. **Simpler code**: ~50 lines vs ~1000 lines
2. **Support for .docx**: Uploaded Word docs now work
3. **Google handles conversion**: Less maintenance burden for native docs
4. **Same auth**: Uses existing service account credentials

## Limitations

- `files.export` limited to 10MB (sufficient for most documents)
- HTML from `files.export` is verbose with inline styles (acceptable, gets cleaned by Readability anyway)
- mammoth may not handle all .docx features perfectly (footnotes, complex tables)

## Dependencies

- `mammoth`
- `google-auth-library` (already installed)

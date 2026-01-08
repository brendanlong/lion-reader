# Google Docs API Reference

Reference documentation for the Google Docs API v1, focused on document retrieval and content structure.

**Official Documentation**: https://developers.google.com/docs/api/reference/rest

## API Endpoint

```
GET https://docs.googleapis.com/v1/documents/{documentId}
```

**Authentication**: OAuth2 Bearer token (API keys not supported)

**Response**: JSON `Document` object

## Document Structure

```json
{
  "documentId": "string",
  "title": "string",
  "revisionId": "string",
  "body": { "content": [StructuralElement] },
  "lists": { "listId": List },
  "inlineObjects": { "objectId": InlineObject },
  "footnotes": { "footnoteId": Footnote }
}
```

### Key Fields

| Field           | Type                      | Description                        |
| --------------- | ------------------------- | ---------------------------------- |
| `documentId`    | string                    | Unique document identifier         |
| `title`         | string                    | Document title                     |
| `revisionId`    | string                    | Revision ID (valid for 24 hours)   |
| `body`          | Body                      | Main document content              |
| `lists`         | map<string, List>         | List definitions keyed by list ID  |
| `inlineObjects` | map<string, InlineObject> | Images/drawings keyed by object ID |
| `footnotes`     | map<string, Footnote>     | Footnotes keyed by footnote ID     |

## Body and StructuralElement

The `body.content` array contains `StructuralElement` objects:

```json
{
  "startIndex": 0,
  "endIndex": 100,
  // One of:
  "paragraph": Paragraph,
  "table": Table,
  "sectionBreak": SectionBreak,
  "tableOfContents": TableOfContents
}
```

## Paragraph

```json
{
  "elements": [ParagraphElement],
  "paragraphStyle": {
    "namedStyleType": "NORMAL_TEXT" | "TITLE" | "SUBTITLE" | "HEADING_1" | ... | "HEADING_6",
    "alignment": "START" | "CENTER" | "END" | "JUSTIFIED",
    "direction": "LEFT_TO_RIGHT" | "RIGHT_TO_LEFT"
  },
  "bullet": {
    "listId": "string",
    "nestingLevel": 0
  }
}
```

### Named Style Types (for headings)

| Type          | HTML Equivalent         |
| ------------- | ----------------------- |
| `NORMAL_TEXT` | `<p>`                   |
| `TITLE`       | `<h1>` (document title) |
| `SUBTITLE`    | `<h2>` (subtitle)       |
| `HEADING_1`   | `<h1>`                  |
| `HEADING_2`   | `<h2>`                  |
| `HEADING_3`   | `<h3>`                  |
| `HEADING_4`   | `<h4>`                  |
| `HEADING_5`   | `<h5>`                  |
| `HEADING_6`   | `<h6>`                  |

### Bullet (List Membership)

If `bullet` is present, the paragraph belongs to a list:

- `listId`: References entry in document's `lists` map
- `nestingLevel`: 0-8, indicates indentation depth

## ParagraphElement

```json
{
  "startIndex": 0,
  "endIndex": 50,
  // One of:
  "textRun": TextRun,
  "inlineObjectElement": InlineObjectElement,
  "footnoteReference": FootnoteReference,
  "horizontalRule": HorizontalRule,
  "pageBreak": PageBreak,
  "person": Person,
  "richLink": RichLink
}
```

## TextRun

The primary content element containing styled text:

```json
{
  "content": "Hello world",
  "textStyle": {
    "bold": true,
    "italic": false,
    "underline": false,
    "strikethrough": false,
    "smallCaps": false,
    "baselineOffset": "NONE" | "SUPERSCRIPT" | "SUBSCRIPT",
    "link": {
      "url": "https://example.com"
    },
    "foregroundColor": {
      "color": { "rgbColor": { "red": 0.0, "green": 0.0, "blue": 1.0 } }
    },
    "backgroundColor": { ... },
    "fontSize": { "magnitude": 12, "unit": "PT" },
    "weightedFontFamily": { "fontFamily": "Arial", "weight": 400 }
  }
}
```

### TextStyle Fields

| Field            | Type    | HTML Equivalent                    |
| ---------------- | ------- | ---------------------------------- |
| `bold`           | boolean | `<strong>`                         |
| `italic`         | boolean | `<em>`                             |
| `underline`      | boolean | `<u>`                              |
| `strikethrough`  | boolean | `<s>` or `<del>`                   |
| `smallCaps`      | boolean | `style="font-variant: small-caps"` |
| `baselineOffset` | enum    | `<sup>` or `<sub>`                 |
| `link.url`       | string  | `<a href="...">`                   |

### Link Destinations

Links can point to:

```json
// External URL
{ "url": "https://example.com" }

// Bookmark in document
{ "bookmark": { "id": "bookmarkId", "tabId": "tabId" } }

// Heading in document
{ "heading": { "id": "headingId", "tabId": "tabId" } }

// Tab in document
{ "tabId": "tabId" }
```

## InlineObjectElement (Images)

Reference to an image or drawing:

```json
{
  "inlineObjectId": "kix.abc123"
}
```

Look up in document's `inlineObjects` map:

```json
{
  "objectId": "kix.abc123",
  "inlineObjectProperties": {
    "embeddedObject": {
      "title": "Image title",
      "description": "Alt text",
      "imageProperties": {
        "contentUri": "https://...", // Temporary URI (30 min)
        "sourceUri": "https://..." // Original source
      },
      "size": {
        "width": { "magnitude": 400, "unit": "PT" },
        "height": { "magnitude": 300, "unit": "PT" }
      }
    }
  }
}
```

**Note**: `contentUri` expires after 30 minutes and is scoped to the requester's account.

## FootnoteReference

```json
{
  "footnoteId": "footnote123",
  "footnoteNumber": "1"
}
```

Look up content in document's `footnotes` map:

```json
{
  "footnoteId": "footnote123",
  "content": [StructuralElement]  // Same structure as body.content
}
```

## HorizontalRule

```json
{
  "textStyle": { ... }  // Style applied to the rule
}
```

Convert to `<hr>`.

## Table

```json
{
  "rows": 3,
  "columns": 2,
  "tableRows": [
    {
      "tableCells": [
        {
          "content": [StructuralElement],
          "tableCellStyle": {
            "rowSpan": 1,
            "columnSpan": 1,
            "backgroundColor": { ... },
            "borderLeft": { "color": {...}, "width": {...} },
            "paddingLeft": { "magnitude": 5, "unit": "PT" }
          }
        }
      ],
      "tableRowStyle": {
        "tableHeader": true,  // If true, this row is a header
        "minRowHeight": { "magnitude": 20, "unit": "PT" }
      }
    }
  ]
}
```

**Note**: Tables can be non-rectangular (rows may have different cell counts).

## List

List definitions are stored in document's `lists` map:

```json
{
  "listProperties": {
    "nestingLevels": [
      {
        "bulletAlignment": "START" | "CENTER" | "END",
        "glyphType": "DECIMAL" | "UPPER_ALPHA" | "ALPHA" | "UPPER_ROMAN" | "ROMAN" | "NONE",
        "glyphSymbol": "●",  // For unordered lists
        "glyphFormat": "%0.",
        "startNumber": 1,
        "indentFirstLine": { "magnitude": 18, "unit": "PT" },
        "indentStart": { "magnitude": 36, "unit": "PT" }
      }
    ]
  }
}
```

### Glyph Types (Ordered Lists)

| Type           | Example     |
| -------------- | ----------- |
| `DECIMAL`      | 1, 2, 3     |
| `ZERO_DECIMAL` | 01, 02, 03  |
| `UPPER_ALPHA`  | A, B, C     |
| `ALPHA`        | a, b, c     |
| `UPPER_ROMAN`  | I, II, III  |
| `ROMAN`        | i, ii, iii  |
| `NONE`         | (no marker) |

### Common Glyph Symbols (Unordered Lists)

| Unicode | Symbol            |
| ------- | ----------------- |
| U+25CF  | ● (filled circle) |
| U+25CB  | ○ (hollow circle) |
| U+25A0  | ■ (filled square) |
| U+25A1  | □ (hollow square) |
| U+2013  | – (en dash)       |

## Person (@ Mentions)

```json
{
  "personId": "uniqueId",
  "personProperties": {
    "name": "John Doe",
    "email": "john@example.com"
  }
}
```

## RichLink (Google Resource Links)

Links to Google Drive files, YouTube videos, Calendar events:

```json
{
  "richLinkId": "uniqueId",
  "richLinkProperties": {
    "title": "Document Title",
    "uri": "https://docs.google.com/...",
    "mimeType": "application/vnd.google-apps.document"
  }
}
```

## Color Representation

```json
{
  "color": {
    "rgbColor": {
      "red": 0.0, // 0.0 to 1.0
      "green": 0.5,
      "blue": 1.0
    }
  }
}
```

Convert to CSS: `rgb(0, 128, 255)` or hex `#0080ff`.

**Note**: If `color` is unset in `OptionalColor`, it represents transparent.

## Dimension

```json
{
  "magnitude": 12.0,
  "unit": "PT" // Points (1/72 inch)
}
```

Only `PT` (points) is used.

## Tabs (Multi-Tab Documents)

Documents can have multiple tabs. Use `includeTabsContent=true` query parameter to get all tabs:

```json
{
  "tabs": [
    {
      "tabProperties": {
        "tabId": "t.0",
        "title": "Tab 1",
        "index": 0
      },
      "documentTab": {
        "body": { ... },
        "lists": { ... },
        "inlineObjects": { ... }
      },
      "childTabs": [ ... ]
    }
  ]
}
```

**Default behavior**: Without `includeTabsContent=true`, the legacy `body`, `lists`, etc. fields at the document root contain only the first tab's content.

## Error Responses

| Status | Meaning                                  |
| ------ | ---------------------------------------- |
| 400    | Bad request (invalid document ID format) |
| 401    | Invalid or expired token                 |
| 403    | No permission to access document         |
| 404    | Document not found                       |
| 429    | Rate limit exceeded                      |

## Rate Limits

- 300 requests per minute per project
- 60 requests per minute per user

## Special Characters

- Non-text elements in `TextRun.content` are replaced with U+E907
- Newlines terminate paragraphs
- Page breaks and column breaks are separate elements

## Conversion Notes

1. **Text runs can span multiple styles** - Split on style boundaries
2. **Empty paragraphs** - May contain only newline character
3. **List continuity** - Consecutive paragraphs with same `listId` are part of same list
4. **Nested lists** - Use `nestingLevel` to determine depth
5. **Table cells** - Contain full `StructuralElement` arrays (can have paragraphs, lists, nested tables)
6. **Image URIs expire** - Consider downloading/caching images if persistence needed

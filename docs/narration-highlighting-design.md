# Narration Highlighting Design

## Overview

When audio narration is playing, the currently-read paragraph is highlighted in the article view. This provides visual feedback, helps users follow along, and allows them to see where they are in the article.

### Design Principles

1. **Good enough mapping**: Perfect alignment between narration and original content isn't required—close enough is fine
2. **Graceful degradation**: If mapping fails, playback continues without highlighting
3. **Minimal latency**: No additional API calls during playback—mapping computed at generation time
4. **Works with both providers**: Browser TTS and Piper TTS both support highlighting

---

## Challenge: Narration-to-Content Mapping

The LLM transforms article content significantly:

| Original HTML                            | LLM Narration Output                       |
| ---------------------------------------- | ------------------------------------------ |
| `<p>Dr. Smith said...</p>`               | `Doctor Smith said...`                     |
| `<pre><code>npm install</code></pre>`    | `Code block: npm install. End code block.` |
| `<img alt="Dashboard">`                  | `Image: Dashboard.`                        |
| `<a href="https://example.com">link</a>` | `link to example dot com`                  |

A simple text match won't work. Instead, we need to track which original paragraph(s) contributed to each narration paragraph.

---

## Architecture

### Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Original HTML  │────▶│  Preprocessing  │────▶│  Marked HTML    │
│  (article)      │     │  (add para IDs) │     │  (with markers) │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Paragraph Map   │◀────│  Parse Markers  │◀────│  LLM Output     │
│ (stored in DB)  │     │                 │     │  (with markers) │
└────────┬────────┘     └─────────────────┘     └─────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                     During Playback                              │
├─────────────────────────────────────────────────────────────────┤
│  Narration paragraph index (from ArticleNarrator/Piper)          │
│                         ↓                                        │
│  Look up in paragraph map                                        │
│                         ↓                                        │
│  Get original paragraph ID(s)                                    │
│                         ↓                                        │
│  Highlight element(s) with data-para-id in DOM                  │
└─────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component             | Responsibility                                           |
| --------------------- | -------------------------------------------------------- |
| **HTML Preprocessor** | Assign `data-para-id` attributes to block-level elements |
| **LLM Prompt**        | Request paragraph markers in output                      |
| **Marker Parser**     | Extract paragraph mapping from LLM output                |
| **Narration Service** | Store mapping alongside narration text                   |
| **Highlighting Hook** | Track current paragraph and update highlight             |
| **Entry Content**     | Apply highlight styles based on hook state               |

---

## Implementation Details

### Step 1: HTML Preprocessing

Before sending content to the LLM, we assign stable IDs to block-level elements. This happens server-side during narration generation.

```typescript
interface PreprocessResult {
  markedHtml: string; // HTML with data-para-id attributes
  paragraphElements: string[]; // Array of element IDs in order
}

function preprocessHtmlForNarration(html: string): PreprocessResult {
  // Block-level elements that can be highlighted
  const BLOCK_ELEMENTS = [
    "p",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "pre",
    "ul",
    "ol",
    "li",
    "figure",
    "table",
  ];

  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const elements: string[] = [];
  let paraIndex = 0;

  // Find all block elements and assign IDs
  for (const tagName of BLOCK_ELEMENTS) {
    doc.querySelectorAll(tagName).forEach((el) => {
      const id = `para-${paraIndex++}`;
      el.setAttribute("data-para-id", id);
      elements.push(id);
    });
  }

  // Re-order elements array by document order
  const orderedElements: string[] = [];
  doc.querySelectorAll("[data-para-id]").forEach((el) => {
    orderedElements.push(el.getAttribute("data-para-id")!);
  });

  return {
    markedHtml: doc.body.innerHTML,
    paragraphElements: orderedElements,
  };
}
```

### Step 2: Modified LLM Prompt

Update the narration prompt to request paragraph markers:

```typescript
const NARRATION_SYSTEM_PROMPT = `Convert this article to narration-ready plain text for text-to-speech.

IMPORTANT: Insert paragraph markers to track which original paragraph each narration section comes from.
- Use [PARA:X] markers where X is the original paragraph number (starting from 0)
- Place marker at the START of each section that corresponds to an original paragraph
- If you combine paragraphs, include all their markers: [PARA:2][PARA:3]
- If you skip content (like complex tables), still include the marker with a note

Rules:
- Output plain text with blank lines between paragraphs
- Call out special content: "Code block: ... End code block.", "Image: [alt].", "Table with N columns: ..."
- Expand abbreviations (Dr. → Doctor, etc. → et cetera)
- Read URLs as "link to [domain]" or skip if already in link text
- Convert lists to numbered format (1. ... 2. ... 3. ...) to preserve structure
- Split very long paragraphs at natural points (keep same marker)
- Keep the content faithful to the original—do not summarize or editorialize

Example input with markers:
---
[P:0] First paragraph with Dr. Smith.
[P:1] Second paragraph.
[P:2] <pre><code>npm install</code></pre>
---

Example output:
---
[PARA:0]First paragraph with Doctor Smith.

[PARA:1]Second paragraph.

[PARA:2]Code block: npm install. End code block.
---

Article content:
---
{content_with_markers}
---

Narration text:`;
```

### Step 3: Input Preparation

Modify `htmlToNarrationInput` to include paragraph markers:

```typescript
function htmlToNarrationInput(html: string): {
  inputText: string;
  paragraphOrder: string[]; // IDs in order for mapping
} {
  const { markedHtml, paragraphElements } = preprocessHtmlForNarration(html);

  const dom = new JSDOM(markedHtml);
  const doc = dom.window.document;
  const lines: string[] = [];

  // Walk through elements and build input with markers
  doc.querySelectorAll("[data-para-id]").forEach((el) => {
    const paraId = el.getAttribute("data-para-id");
    const index = paragraphElements.indexOf(paraId!);

    // Add marker prefix
    const marker = `[P:${index}]`;

    // Process element content
    const content = processElementForNarration(el);
    if (content) {
      lines.push(`${marker} ${content}`);
    }
  });

  return {
    inputText: lines.join("\n"),
    paragraphOrder: paragraphElements,
  };
}
```

### Step 4: Parse LLM Output

Extract paragraph mapping from LLM output:

```typescript
interface ParagraphMapping {
  narrationParagraphs: string[]; // Narration text split by paragraph
  mapping: NarrationToOriginal[]; // Map narration index → original IDs
}

interface NarrationToOriginal {
  narrationIndex: number;
  originalIndices: number[]; // Can map to multiple (if LLM combined)
}

function parseNarrationOutput(llmOutput: string, paragraphOrder: string[]): ParagraphMapping {
  // Split into paragraphs (by double newline)
  const rawParagraphs = llmOutput
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const narrationParagraphs: string[] = [];
  const mapping: NarrationToOriginal[] = [];

  // Regex to find [PARA:X] markers
  const markerRegex = /\[PARA:(\d+)\]/g;

  rawParagraphs.forEach((para, narrationIndex) => {
    // Extract all markers from this paragraph
    const indices: number[] = [];
    let match;
    while ((match = markerRegex.exec(para)) !== null) {
      indices.push(parseInt(match[1], 10));
    }

    // Remove markers from text
    const cleanText = para.replace(markerRegex, "").trim();

    if (cleanText) {
      narrationParagraphs.push(cleanText);
      mapping.push({
        narrationIndex: narrationParagraphs.length - 1,
        originalIndices: indices.length > 0 ? indices : [narrationIndex], // fallback
      });
    }
  });

  return { narrationParagraphs, mapping };
}
```

### Step 5: Store Mapping

Add paragraph mapping to the database schema and narration response:

```sql
-- Add to narration_content table
ALTER TABLE narration_content ADD COLUMN paragraph_map jsonb;

-- Format: [{"n": 0, "o": [0]}, {"n": 1, "o": [1, 2]}, ...]
-- n = narration paragraph index
-- o = original paragraph indices (can be multiple if LLM combined)
```

Update the narration service:

```typescript
// In generateNarrationWithMapping()
const { inputText, paragraphOrder } = htmlToNarrationInput(sourceContent);

const llmOutput = await groq.chat.completions.create({
  model: "llama-3.1-8b-instant",
  messages: [
    { role: "system", content: NARRATION_SYSTEM_PROMPT },
    { role: "user", content: inputText },
  ],
  temperature: 0.1,
  max_tokens: 8000,
});

const rawOutput = llmOutput.choices[0]?.message?.content || "";
const { narrationParagraphs, mapping } = parseNarrationOutput(rawOutput, paragraphOrder);

// Store cleaned narration text (markers removed)
const narrationText = narrationParagraphs.join("\n\n");

// Store mapping for highlighting
const paragraphMap = mapping.map((m) => ({ n: m.narrationIndex, o: m.originalIndices }));

await db.narrationContent.update(narrationId, {
  content_narration: narrationText,
  paragraph_map: paragraphMap,
  generated_at: new Date(),
});
```

### Step 6: API Response

Update the narration API to return the mapping:

```typescript
// Updated response type
interface NarrationResponse {
  narration: string;
  cached: boolean;
  source: "llm" | "fallback";
  paragraphMap?: Array<{ n: number; o: number[] }>; // New field
}

// In narration.generate endpoint
return {
  narration: narration.content_narration,
  cached: true,
  source: "llm",
  paragraphMap: narration.paragraph_map || null,
};
```

### Step 7: Client-Side Highlighting Hook

Create a hook to manage highlighting state:

```typescript
// /src/components/narration/useNarrationHighlight.ts

interface UseNarrationHighlightProps {
  paragraphMap: Array<{ n: number; o: number[] }> | null;
  currentParagraphIndex: number;
  isPlaying: boolean;
}

interface UseNarrationHighlightResult {
  highlightedParagraphIds: Set<number>; // Original paragraph indices
}

export function useNarrationHighlight({
  paragraphMap,
  currentParagraphIndex,
  isPlaying,
}: UseNarrationHighlightProps): UseNarrationHighlightResult {
  const highlightedParagraphIds = useMemo(() => {
    if (!isPlaying || !paragraphMap || currentParagraphIndex < 0) {
      return new Set<number>();
    }

    // Find mapping for current narration paragraph
    const mapping = paragraphMap.find((m) => m.n === currentParagraphIndex);
    if (!mapping) {
      // Fallback: highlight paragraph at same index
      return new Set([currentParagraphIndex]);
    }

    return new Set(mapping.o);
  }, [paragraphMap, currentParagraphIndex, isPlaying]);

  return { highlightedParagraphIds };
}
```

### Step 8: Entry Content Component

Update the entry content component to apply highlighting:

```typescript
// /src/components/entries/EntryContent.tsx

interface EntryContentProps {
  content: string;
  highlightedParagraphIds?: Set<number>;
}

export function EntryContent({ content, highlightedParagraphIds }: EntryContentProps) {
  // Process HTML to add paragraph IDs (client-side)
  const processedContent = useMemo(() => {
    if (!highlightedParagraphIds || highlightedParagraphIds.size === 0) {
      return content;
    }
    return addParagraphIdsToHtml(content);
  }, [content, highlightedParagraphIds]);

  // Apply highlight class via CSS custom properties or inline styles
  const getHighlightClass = (paraId: number) => {
    return highlightedParagraphIds?.has(paraId) ? 'bg-yellow-100 dark:bg-yellow-900/30' : '';
  };

  return (
    <NarrationHighlightContext.Provider value={{ highlightedParagraphIds }}>
      <div
        className="prose dark:prose-invert"
        dangerouslySetInnerHTML={{ __html: processedContent }}
      />
    </NarrationHighlightContext.Provider>
  );
}
```

### Step 9: CSS Styling

Add highlight styles:

```css
/* Highlight the currently-read paragraph */
[data-para-id].narration-highlight {
  background-color: rgba(253, 230, 138, 0.3); /* yellow-200/30 */
  border-radius: 0.25rem;
  transition: background-color 0.3s ease;
}

/* Dark mode */
.dark [data-para-id].narration-highlight {
  background-color: rgba(113, 63, 18, 0.3); /* yellow-900/30 */
}

/* Smooth scroll to highlighted paragraph */
[data-para-id].narration-highlight {
  scroll-margin-top: 100px; /* Account for header */
}
```

### Step 10: Auto-Scroll Behavior

Optionally scroll to the current paragraph:

```typescript
// In useNarrationHighlight
useEffect(() => {
  if (!isPlaying || highlightedParagraphIds.size === 0) return;

  const firstId = Array.from(highlightedParagraphIds)[0];
  const element = document.querySelector(`[data-para-id="para-${firstId}"]`);

  if (element) {
    // Only scroll if element is not in viewport
    const rect = element.getBoundingClientRect();
    const isInViewport = rect.top >= 0 && rect.bottom <= window.innerHeight;

    if (!isInViewport) {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}, [highlightedParagraphIds, isPlaying]);
```

---

## Fallback Handling

### When LLM Doesn't Return Markers

If the LLM output doesn't contain `[PARA:X]` markers, fall back to positional mapping:

```typescript
function createPositionalMapping(
  narrationParagraphCount: number,
  originalParagraphCount: number
): NarrationToOriginal[] {
  const mapping: NarrationToOriginal[] = [];

  for (let i = 0; i < narrationParagraphCount; i++) {
    // Simple 1:1 mapping, capped at original count
    const originalIndex = Math.min(i, originalParagraphCount - 1);
    mapping.push({ narrationIndex: i, originalIndices: [originalIndex] });
  }

  return mapping;
}
```

### When Using Fallback TTS

For `htmlToPlainText` fallback (no LLM), we can still create a basic mapping since the paragraphs are derived directly from the original content:

```typescript
function createFallbackMapping(html: string): ParagraphMapping {
  const { paragraphElements } = preprocessHtmlForNarration(html);
  const plainText = htmlToPlainText(html);
  const narrationParagraphs = plainText.split(/\n\n+/).filter((p) => p.trim());

  // Assume 1:1 correspondence (imperfect but better than nothing)
  return {
    narrationParagraphs,
    mapping: narrationParagraphs.map((_, i) => ({
      narrationIndex: i,
      originalIndices: [Math.min(i, paragraphElements.length - 1)],
    })),
  };
}
```

---

## Database Schema

```sql
-- Migration: Add paragraph_map to narration_content
ALTER TABLE narration_content ADD COLUMN paragraph_map jsonb;

-- Example data:
-- paragraph_map = [
--   {"n": 0, "o": [0]},        -- narration para 0 → original para 0
--   {"n": 1, "o": [1, 2]},     -- narration para 1 → original paras 1 & 2 (combined)
--   {"n": 2, "o": [3]},        -- narration para 2 → original para 3
-- ]
```

---

## Integration with Existing Code

### Updates to useNarration Hook

```typescript
// Add paragraphMap to state
const [paragraphMap, setParagraphMap] = useState<Array<{ n: number; o: number[] }> | null>(null);

// In generateNarration mutation success handler
onSuccess: (data) => {
  setNarrationText(data.narration);
  setParagraphMap(data.paragraphMap ?? null);
},

// Expose in return
return {
  // ... existing returns
  paragraphMap,
};
```

### Updates to NarrationControls

```typescript
// In parent component (entry view)
const { state, paragraphMap, ...narration } = useNarration({ ... });
const { highlightedParagraphIds } = useNarrationHighlight({
  paragraphMap,
  currentParagraphIndex: state.currentParagraph,
  isPlaying: state.status === 'playing',
});

// Pass to EntryContent
<EntryContent
  content={entry.content_cleaned || entry.content_original}
  highlightedParagraphIds={highlightedParagraphIds}
/>
```

---

## User Settings

Add optional setting for auto-scroll behavior:

```typescript
interface NarrationSettings {
  // ... existing fields
  highlightEnabled: boolean; // Default: true
  autoScrollEnabled: boolean; // Default: true
}
```

---

## Limitations

| Limitation                       | Impact                          | Mitigation                         |
| -------------------------------- | ------------------------------- | ---------------------------------- |
| LLM may not return markers       | No highlighting                 | Fallback to positional mapping     |
| LLM may merge/split paragraphs   | Imprecise highlighting          | Allow multi-paragraph highlighting |
| Code blocks are read differently | Highlight may not match exactly | Acceptable UX tradeoff             |
| Tables may be summarized         | Highlight entire table          | Good enough for user orientation   |

---

## Metrics

```typescript
// Track highlighting usage
narration_highlight_active_total; // Times highlighting was active
narration_highlight_fallback_total; // Times fallback mapping was used
narration_highlight_scroll_total; // Times auto-scroll triggered
```

---

## Future Enhancements

1. **Sentence-level highlighting**: Track word position within paragraphs for finer highlighting
2. **Karaoke mode**: Highlight word-by-word as they're spoken (requires SSML timing)
3. **Click to seek**: Click on a paragraph to jump narration to that point
4. **Highlight trail**: Keep recently-read paragraphs dimly highlighted for context

---

## Implementation Checklist

### PR 1: Database & Backend Changes

- [ ] Add `paragraph_map` column to `narration_content` table
- [ ] Implement `preprocessHtmlForNarration()` function
- [ ] Update `htmlToNarrationInput()` to include paragraph markers
- [ ] Update LLM prompt to request paragraph markers
- [ ] Implement `parseNarrationOutput()` to extract mapping
- [ ] Store paragraph map in database alongside narration
- [ ] Update narration API response to include `paragraphMap`
- [ ] Add fallback positional mapping when markers missing
- [ ] Write unit tests for preprocessing and parsing

### PR 2: Client-Side Highlighting

- [ ] Create `useNarrationHighlight` hook
- [ ] Add client-side paragraph ID assignment to entry content
- [ ] Add highlight CSS styles (light and dark mode)
- [ ] Integrate highlighting with `useNarration` hook
- [ ] Update `EntryContent` component to accept highlight state
- [ ] Implement smooth scroll to highlighted paragraph
- [ ] Add highlight toggle to narration settings
- [ ] Write unit tests for highlighting hook

### PR 3: Polish & Metrics

- [ ] Add auto-scroll enable/disable setting
- [ ] Add metrics for highlighting usage
- [ ] Test with various content types (code, images, tables)
- [ ] Test with both TTS providers (browser and Piper)
- [ ] Handle edge cases (empty content, single paragraph)
- [ ] Update keyboard shortcuts help if needed

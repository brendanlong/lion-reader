# AI Summarization Feature Design

## Overview

AI summarization allows users to generate concise summaries of articles using an LLM. When a user clicks "Summarize" in the entry header, the article content is sent to an LLM (configurable, defaulting to Claude Sonnet) for summarization. The summary is displayed in a collapsible card at the top of the entry content and cached for future requests.

### Design Principles

1. **On-demand generation**: Summaries are only generated when requested, avoiding unnecessary API costs
2. **Content deduplication**: Summaries are cached by content hash, so identical content across entries shares one summary
3. **Provider flexibility**: Architecture supports multiple LLM providers (Anthropic, OpenAI, Groq)
4. **Graceful degradation**: Clear error handling when LLM is unavailable or fails
5. **Shared across users**: Since the prompt is consistent, summaries are shared across all users

---

## Architecture

### Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Article HTML   │────▶│  LLM Provider   │────▶│  Summary Text   │
│  (full_content  │     │  (Anthropic/    │     │ (stored in DB)  │
│   or content_   │     │   OpenAI/Groq)  │     │                 │
│   cleaned)      │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Entry Content  │◀────│  Summary Card   │◀────│  Cache Lookup   │
│  Display        │     │  (collapsible)  │     │  by contentHash │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### Component Responsibilities

| Component                 | Responsibility                                          |
| ------------------------- | ------------------------------------------------------- |
| **Summarization Service** | Generate summaries via LLM, manage caching and errors   |
| **entry_summaries Table** | Cache summaries by content hash for deduplication       |
| **tRPC Router**           | Handle summarize requests with visibility checks        |
| **SummaryCard**           | Display summary in collapsible card above entry content |

---

## LLM Integration

### Provider Configuration

The default provider is Anthropic Claude Sonnet. Configuration via environment variables:

```bash
# Anthropic (default)
ANTHROPIC_API_KEY=sk-ant-...

# Optional: Override model (default: claude-sonnet-4-20250514)
SUMMARIZATION_MODEL=claude-sonnet-4-20250514
```

### Provider Abstraction

```typescript
interface SummarizationProvider {
  summarize(content: string): Promise<string>;
}

// Factory function based on environment
function getSummarizationProvider(): SummarizationProvider | null {
  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider();
  }
  // Future: OpenAI, Groq support
  return null;
}
```

### Prompt Template

```
Summarize this article in 2-3 concise paragraphs. Focus on:
- The main topic or argument
- Key points and findings
- Important conclusions or takeaways

Keep the summary factual and objective. Do not add opinions or commentary.
Do not use phrases like "This article discusses" or "The author argues".
Write in a direct, informative style.

Article content:
---
{content}
---

Summary:
```

### Content Preparation

Content is prepared for summarization in this priority order:

1. `fullContentCleaned` - Full article fetched from URL (best quality)
2. `contentCleaned` - Readability-processed feed content
3. `contentOriginal` - Raw feed content (fallback)

HTML is converted to plain text before sending to the LLM to reduce token usage.

### Content Length Limits

To control costs, content is truncated before sending:

- **Maximum input**: 50,000 characters (~12,500 tokens)
- **Maximum output**: 1,000 tokens

Articles exceeding the limit are truncated with a note in the summary.

---

## Database Schema

### Schema Design

A separate table keyed by content hash for deduplication:

```sql
CREATE TABLE entry_summaries (
  id uuid PRIMARY KEY DEFAULT gen_uuidv7(),
  content_hash text UNIQUE NOT NULL,      -- SHA256 of source content

  summary_text text,                      -- null until generated
  model_id text,                          -- e.g., "claude-sonnet-4-20250514"
  prompt_version smallint NOT NULL DEFAULT 1,  -- for cache invalidation

  created_at timestamptz NOT NULL DEFAULT now(),
  generated_at timestamptz,               -- when summary was generated

  -- Error tracking for retry logic
  error text,
  error_at timestamptz
);

-- Index for identifying stale summaries (optional background refresh)
CREATE INDEX idx_entry_summaries_prompt_version
  ON entry_summaries (prompt_version)
  WHERE summary_text IS NOT NULL;
```

### Content Hash Strategy

Entries already have `content_hash` computed from their content. The summarization service:

1. Gets the best available content (full > cleaned > original)
2. Computes SHA256 hash of that content
3. Looks up existing summary by hash
4. Creates new summary if not found or stale

### Cache Invalidation

When the prompt or model changes:

1. Increment `CURRENT_PROMPT_VERSION` constant
2. Summaries with old `prompt_version` are considered stale
3. Options for stale summaries:
   - Show stale summary with "Regenerate" option
   - Automatically regenerate on next request
   - Background job to refresh (future)

### Error Handling

When LLM returns an error:

1. Store error message in `error` and timestamp in `error_at`
2. Return error to user (no fallback for summarization)
3. Allow retry after 1 hour (check `error_at` before regenerating)
4. Clear error columns on successful generation

```typescript
const RETRY_AFTER_MS = 60 * 60 * 1000; // 1 hour

const canRetry = !summary.errorAt || Date.now() - summary.errorAt.getTime() > RETRY_AFTER_MS;
```

---

## API Design

### Generate Summary Endpoint

```typescript
// tRPC procedure
summarization: {
  generate: protectedProcedure
    .input(z.object({ entryId: z.string().uuid() }))
    .output(z.object({
      summary: z.string(),
      cached: z.boolean(),
      modelId: z.string(),
      generatedAt: z.date().nullable(),
    }))
    .mutation(async ({ ctx, input }) => {
      // 1. Fetch entry with visibility check
      // 2. Get best content (full > cleaned > original)
      // 3. Compute content hash
      // 4. Check cache by hash
      // 5. Generate if not cached or stale
      // 6. Return summary
    }),

  isAvailable: publicProcedure
    .output(z.object({ available: z.boolean() }))
    .query(() => {
      return { available: isSummarizationAvailable() };
    }),
}
```

### Service Layer

```typescript
// src/server/services/summarization.ts

export async function generateSummary(
  db: DbType,
  params: {
    contentHash: string;
    content: string;
  }
): Promise<GenerateSummaryResult> {
  // Check cache
  // Generate via LLM if needed
  // Store result
  // Return summary
}

export function isSummarizationAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}
```

---

## Frontend Design

### SummaryCard Component

Displayed at the top of entry content when a summary exists:

```typescript
interface SummaryCardProps {
  summary: string;
  modelId: string;
  generatedAt: Date | null;
  isLoading: boolean;
  onRegenerate?: () => void;
}

function SummaryCard({ summary, modelId, generatedAt, isLoading, onRegenerate }: SummaryCardProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-900/20">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <SparklesIcon className="h-4 w-4 text-blue-600" />
          <span className="font-medium text-blue-900 dark:text-blue-100">
            AI Summary
          </span>
        </div>
        <button onClick={() => setIsCollapsed(!isCollapsed)}>
          {isCollapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
        </button>
      </div>

      {!isCollapsed && (
        <>
          <div className="prose prose-sm dark:prose-invert">
            {summary}
          </div>
          <div className="mt-2 text-xs text-blue-600 dark:text-blue-400">
            Generated by {modelId}
            {generatedAt && ` on ${formatDate(generatedAt)}`}
          </div>
        </>
      )}
    </div>
  );
}
```

### Summarize Button

Added to the action buttons in EntryContentBody header:

```typescript
{isSummarizationAvailable && (
  <Button
    variant="secondary"
    size="sm"
    onClick={handleSummarize}
    disabled={isSummarizing}
  >
    {isSummarizing ? (
      <>
        <Spinner className="h-4 w-4" />
        <span className="ml-2">Summarizing...</span>
      </>
    ) : hasSummary ? (
      <>
        <SparklesIcon className="h-4 w-4" />
        <span className="ml-2">View Summary</span>
      </>
    ) : (
      <>
        <SparklesIcon className="h-4 w-4" />
        <span className="ml-2">Summarize</span>
      </>
    )}
  </Button>
)}
```

### State Management

Summary state is managed locally in EntryContent:

```typescript
const [summary, setSummary] = useState<SummaryData | null>(null);
const [showSummary, setShowSummary] = useState(false);

const summarizeMutation = trpc.summarization.generate.useMutation({
  onSuccess: (data) => {
    setSummary(data);
    setShowSummary(true);
  },
});

const handleSummarize = () => {
  if (summary) {
    setShowSummary(!showSummary);
  } else {
    summarizeMutation.mutate({ entryId });
  }
};
```

---

## Privacy Considerations

### Data Flow Disclosure

Article content is sent to the LLM provider when summarization is requested. This should be disclosed in the privacy policy:

> **AI Summarization**: When you use the summarize feature, article content is sent to our AI provider (Anthropic) to generate a summary. Summaries are cached on our servers and shared across all users viewing the same content.

### Privacy Policy Updates

Add to existing privacy policy:

```markdown
## Third-Party Services

### AI Summarization (Anthropic)

When you click "Summarize" on an article, its content is sent to Anthropic
to generate a concise summary. The summary is cached on our servers and
shared with other users viewing the same article content.

Anthropic's privacy policy: https://www.anthropic.com/privacy
```

---

## Metrics

```typescript
// Summarization usage
summarization_generated_total{cached="true|false", model}
summarization_requested_total

// Quality signals
summarization_generation_duration_seconds
summarization_generation_errors_total{error_type}
summarization_input_tokens_total
summarization_output_tokens_total

// Cache efficiency
summarization_cache_hit_rate
```

---

## Implementation Checklist

### MVP (v1)

- [ ] Database migration:
  - Create `entry_summaries` table (keyed by content_hash)
  - Add index for prompt version (stale summary detection)
- [ ] Anthropic integration for summarization
- [ ] tRPC endpoint for summary generation
- [ ] Content hash lookup and caching
- [ ] Error handling with retry after 1 hour
- [ ] SummaryCard component for displaying summaries
- [ ] Summarize button in entry header
- [ ] isAvailable endpoint for feature detection
- [ ] Privacy policy update
- [ ] Basic metrics

### Future (v2+)

- [ ] Multiple provider support (OpenAI, Groq)
- [ ] User-configurable summary length (short/medium/long)
- [ ] Summary regeneration button for stale summaries
- [ ] Background job to pre-generate summaries for starred articles
- [ ] Summary export in OPML/JSON
- [ ] MCP server integration for summarization

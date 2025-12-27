# Narration Feature Design

## Overview

Audio narration allows users to listen to articles using on-device text-to-speech. Content is preprocessed by an LLM to improve pronunciation and readability.

### Design Principles

1. **Zero marginal cost**: On-device TTS means unlimited listening without per-character fees
2. **Quality through preprocessing**: LLM cleanup fixes abbreviations, URLs, and formatting
3. **Progressive enhancement**: Basic playback first, sync and highlighting in future versions
4. **Transparency**: Users are informed when content is sent to LLM provider

---

## Architecture

### Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Article HTML   │────▶│  LLM Cleanup    │────▶│ Narration Text  │
│  (content_clean │     │  (Groq/Llama)   │     │ (stored in DB)  │
│   ed or         │     │                 │     │                 │
│   content_orig) │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  UI Highlighter │◀────│  Media Session  │◀────│  Web Speech API │
│  (future)       │     │  API Controls   │     │  (on-device)    │
└─────────────────┘     └─────────────────┘     └─────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| **LLM Preprocessor** | Convert article HTML to speakable plain text with paragraph breaks |
| **Web Speech API** | Generate audio on-device using browser/OS voices |
| **Media Session API** | Expose playback controls to OS (lock screen, keyboard media keys) |
| **Voice Settings** | Let users select from available browser voices |

---

## LLM Text Preprocessing

### Provider

Groq (Llama 3.1 8B) for low latency (~1-2s) and low cost (~$0.0002/article).

### Transformation Rules

The LLM converts article HTML to narration-ready plain text:

**Structural elements:**
- Headings: Preserve as paragraph breaks, optionally prefix with "Section:" for major headings
- Paragraphs: Preserve natural breaks
- Lists: Convert to numbered format ("1. ... 2. ... 3. ...") to preserve structure
- Block quotes: Prefix with "Quote:" and suffix with "End quote."

**Special content (read literally with callouts):**
- Code blocks: "Code block: [read code]. End code block."
- Inline code: Read as-is without callout
- Tables: "Table with N columns: [column headers]. Row 1: [values]. Row 2: ..."
- Images with alt text: "Image: [alt text]."
- Images without alt text: "Image with no description."
- Links: Read link text only, skip URL unless it's the primary content

**Text cleanup:**
- URLs: Read domain only ("link to example dot com") or skip if in link text
- Abbreviations: Expand common ones (Dr. → Doctor, etc. → et cetera, e.g. → for example)
- Numbers: Context-appropriate ("$1,000" → "one thousand dollars", "2024" → "twenty twenty-four")
- Acronyms: Leave well-known ones (NASA, FBI), expand obscure ones on first use
- Math: Simple expansion (x² → "x squared", √n → "square root of n")
- Symbols: Spell out (&amp; → "and", % → "percent", @ → "at")

**Paragraph breaks:**
The LLM should identify natural stopping points and ensure reasonable paragraph lengths for the TTS engine. Very long paragraphs should be split at logical boundaries.

### Prompt Template

```
Convert this article to narration-ready plain text for text-to-speech.

Rules:
- Output plain text with blank lines between paragraphs
- Call out special content: "Code block: ... End code block.", "Image: [alt].", "Table with N columns: ..."
- Expand abbreviations (Dr. → Doctor, etc. → et cetera)
- Read URLs as "link to [domain]" or skip if already in link text
- Convert lists to numbered format (1. ... 2. ... 3. ...) to preserve structure
- Split very long paragraphs at natural points
- Keep the content faithful to the original—do not summarize or editorialize

Article content:
---
{content}
---

Narration text:
```

### Example Transformation

**Input:**
```html
<h2>Getting Started</h2>
<p>First, install the package:</p>
<pre><code>npm install lion-reader</code></pre>
<p>Dr. Smith recommends checking the <a href="https://docs.example.com/guide">documentation</a> for more info.</p>
<img src="screenshot.png" alt="The main dashboard showing feed list">
```

**Output:**
```
Getting Started

First, install the package.

Code block: npm install lion-reader. End code block.

Doctor Smith recommends checking the documentation for more info.

Image: The main dashboard showing feed list.
```

---

## Database Schema

### Schema Changes

```sql
-- Add narration columns to entries table
ALTER TABLE entries ADD COLUMN content_narration text;
ALTER TABLE entries ADD COLUMN narration_generated_at timestamptz;
ALTER TABLE entries ADD COLUMN narration_error text;
ALTER TABLE entries ADD COLUMN narration_error_at timestamptz;

-- Add same columns to saved_articles table
ALTER TABLE saved_articles ADD COLUMN content_narration text;
ALTER TABLE saved_articles ADD COLUMN narration_generated_at timestamptz;
ALTER TABLE saved_articles ADD COLUMN narration_error text;
ALTER TABLE saved_articles ADD COLUMN narration_error_at timestamptz;

-- Index for finding entries that need narration generation
CREATE INDEX idx_entries_needs_narration
  ON entries(id)
  WHERE content_narration IS NULL;

CREATE INDEX idx_saved_articles_needs_narration
  ON saved_articles(id)
  WHERE content_narration IS NULL;
```

### Error Handling

When Groq returns an error:
1. Store error message in `narration_error` and timestamp in `narration_error_at`
2. Fall back to plain text conversion for immediate playback
3. Allow retry after 1 hour (check `narration_error_at` before regenerating)
4. Clear error columns on successful generation

```typescript
// Allow retry if error was more than 1 hour ago
const canRetry = !entry.narration_error_at ||
  Date.now() - entry.narration_error_at.getTime() > 60 * 60 * 1000;
```

### Future Schema (for sync and highlighting)

```sql
-- Playback position (future: when implementing cross-device sync)
ALTER TABLE user_entries ADD COLUMN playback_paragraph_index int;
ALTER TABLE user_entries ADD COLUMN playback_updated_at timestamptz;

-- Paragraph mapping (future: when implementing highlighting)
-- Maps paragraph index to character ranges in original content
ALTER TABLE entries ADD COLUMN narration_paragraph_map jsonb;
-- Format: [{"narration_start": 0, "narration_end": 150, "original_start": 0, "original_end": 200}, ...]
```

---

## Web Speech API Integration

### Basic Usage

```typescript
interface NarrationState {
  status: 'idle' | 'loading' | 'playing' | 'paused';
  currentParagraph: number;
  totalParagraphs: number;
  selectedVoice: SpeechSynthesisVoice | null;
}

class ArticleNarrator {
  private paragraphs: string[] = [];
  private currentIndex = 0;
  private utterance: SpeechSynthesisUtterance | null = null;
  
  async loadArticle(narrationText: string) {
    // Split by double newlines (paragraph breaks)
    this.paragraphs = narrationText
      .split(/\n\n+/)
      .map(p => p.trim())
      .filter(p => p.length > 0);
    this.currentIndex = 0;
  }
  
  play(voice?: SpeechSynthesisVoice) {
    if (this.currentIndex >= this.paragraphs.length) return;
    
    this.utterance = new SpeechSynthesisUtterance(
      this.paragraphs[this.currentIndex]
    );
    
    if (voice) {
      this.utterance.voice = voice;
    }
    
    this.utterance.onend = () => {
      this.currentIndex++;
      if (this.currentIndex < this.paragraphs.length) {
        this.play(voice);
      }
    };
    
    speechSynthesis.speak(this.utterance);
  }
  
  pause() {
    speechSynthesis.pause();
  }
  
  resume() {
    speechSynthesis.resume();
  }
  
  stop() {
    speechSynthesis.cancel();
    this.currentIndex = 0;
  }
  
  skipForward() {
    speechSynthesis.cancel();
    this.currentIndex = Math.min(
      this.currentIndex + 1, 
      this.paragraphs.length - 1
    );
    this.play();
  }
  
  skipBackward() {
    speechSynthesis.cancel();
    this.currentIndex = Math.max(this.currentIndex - 1, 0);
    this.play();
  }
}
```

### Voice Selection

```typescript
function getAvailableVoices(): SpeechSynthesisVoice[] {
  return speechSynthesis.getVoices().filter(voice => 
    voice.lang.startsWith('en') // Filter to user's language
  );
}

// Voices load asynchronously in some browsers
function waitForVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise(resolve => {
    const voices = getAvailableVoices();
    if (voices.length > 0) {
      resolve(voices);
    } else {
      speechSynthesis.onvoiceschanged = () => {
        resolve(getAvailableVoices());
      };
    }
  });
}

// Rank voices by quality (heuristic)
function rankVoices(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  return voices.sort((a, b) => {
    // Prefer non-default voices (often higher quality)
    if (a.default !== b.default) return a.default ? 1 : -1;
    // Prefer local voices over remote
    if (a.localService !== b.localService) return a.localService ? -1 : 1;
    // Alphabetical fallback
    return a.name.localeCompare(b.name);
  });
}
```

---

## Media Session API Integration

Enables OS-level playback controls (lock screen, keyboard media keys, headphone buttons).

```typescript
function setupMediaSession(
  articleTitle: string,
  feedTitle: string,
  narrator: ArticleNarrator
) {
  if (!('mediaSession' in navigator)) return;
  
  navigator.mediaSession.metadata = new MediaMetadata({
    title: articleTitle,
    artist: feedTitle,
    album: 'Lion Reader',
    // artwork: [{ src: feedIconUrl, sizes: '512x512', type: 'image/png' }]
  });
  
  navigator.mediaSession.setActionHandler('play', () => {
    narrator.resume();
    navigator.mediaSession.playbackState = 'playing';
  });
  
  navigator.mediaSession.setActionHandler('pause', () => {
    narrator.pause();
    navigator.mediaSession.playbackState = 'paused';
  });
  
  navigator.mediaSession.setActionHandler('stop', () => {
    narrator.stop();
    navigator.mediaSession.playbackState = 'none';
  });
  
  navigator.mediaSession.setActionHandler('previoustrack', () => {
    narrator.skipBackward();
  });
  
  navigator.mediaSession.setActionHandler('nexttrack', () => {
    narrator.skipForward();
  });
}
```

---

## API Endpoints

### Generate Narration

Supports both feed entries and saved articles via discriminated union:

```typescript
// tRPC procedure
narration: {
  generate: protectedProcedure
    .input(z.discriminatedUnion('type', [
      z.object({ type: z.literal('entry'), id: z.string().uuid() }),
      z.object({ type: z.literal('saved'), id: z.string().uuid() }),
    ]))
    .mutation(async ({ ctx, input }) => {
      // Fetch the article (entry or saved)
      const article = input.type === 'entry'
        ? await ctx.db.entries.findById(input.id)
        : await ctx.db.savedArticles.findById(input.id);

      if (!article) {
        throw new TRPCError({ code: 'NOT_FOUND' });
      }

      // Return cached if available
      if (article.content_narration) {
        return {
          narration: article.content_narration,
          cached: true,
          source: 'llm',
        };
      }

      // Check if we should retry after a previous error
      const RETRY_AFTER_MS = 60 * 60 * 1000; // 1 hour
      const canRetryLLM = !article.narration_error_at ||
        Date.now() - article.narration_error_at.getTime() > RETRY_AFTER_MS;

      const sourceContent = article.content_cleaned || article.content_original;

      // If Groq is not configured or we had a recent error, fall back to raw text
      if (!process.env.GROQ_API_KEY || !canRetryLLM) {
        const fallbackText = htmlToPlainText(sourceContent);
        return {
          narration: fallbackText,
          cached: false,
          source: 'fallback',
        };
      }

      try {
        // Generate via LLM
        const narration = await generateNarration(sourceContent);

        // Cache in database, clear any previous error
        const updateFn = input.type === 'entry'
          ? ctx.db.entries.update
          : ctx.db.savedArticles.update;

        await updateFn(article.id, {
          content_narration: narration,
          narration_generated_at: new Date(),
          narration_error: null,
          narration_error_at: null,
        });

        return { narration, cached: false, source: 'llm' };
      } catch (error) {
        // Store error, fall back to plain text
        const updateFn = input.type === 'entry'
          ? ctx.db.entries.update
          : ctx.db.savedArticles.update;

        await updateFn(article.id, {
          narration_error: error instanceof Error ? error.message : 'Unknown error',
          narration_error_at: new Date(),
        });

        const fallbackText = htmlToPlainText(sourceContent);
        return {
          narration: fallbackText,
          cached: false,
          source: 'fallback',
        };
      }
    }),
}

// Simple HTML to plain text for fallback mode
function htmlToPlainText(html: string): string {
  // Basic conversion that strips tags but preserves structure
  return html
    .replace(/<(p|div|br|h[1-6]|li)[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

### LLM Integration

```typescript
import Groq from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function generateNarration(htmlContent: string): Promise<string> {
  // Strip HTML to get clean text with structure hints
  const textContent = htmlToNarrationInput(htmlContent);
  
  const response = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: NARRATION_SYSTEM_PROMPT,
      },
      {
        role: 'user', 
        content: textContent,
      },
    ],
    temperature: 0.1, // Low temperature for consistency
    max_tokens: 8000,
  });
  
  return response.choices[0]?.message?.content || '';
}

function htmlToNarrationInput(html: string): string {
  // Convert HTML to structured text that preserves semantic information
  // for the LLM to process
  // ... implementation details ...
}
```

---

## User Settings

### Settings Schema

```typescript
interface NarrationSettings {
  enabled: boolean;
  voiceUri: string | null;  // SpeechSynthesisVoice.voiceURI
  rate: number;             // 0.5 - 2.0, default 1.0
  pitch: number;            // 0.5 - 2.0, default 1.0
}

// Stored in user preferences (localStorage or user settings table)
```

### Settings UI

```typescript
function NarrationSettings() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [settings, setSettings] = useNarrationSettings();
  
  useEffect(() => {
    waitForVoices().then(setVoices);
  }, []);
  
  const previewVoice = (voice: SpeechSynthesisVoice) => {
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(
      'This is a preview of how articles will sound with this voice.'
    );
    utterance.voice = voice;
    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;
    speechSynthesis.speak(utterance);
  };
  
  return (
    <div>
      <h3>Narration</h3>
      
      <label>
        Voice
        <select 
          value={settings.voiceUri || ''} 
          onChange={e => setSettings({ ...settings, voiceUri: e.target.value })}
        >
          {voices.map(voice => (
            <option key={voice.voiceURI} value={voice.voiceURI}>
              {voice.name} {voice.localService ? '' : '(online)'}
            </option>
          ))}
        </select>
        <button onClick={() => previewVoice(selectedVoice)}>
          Preview
        </button>
      </label>
      
      <p className="text-muted">
        Voices are provided by your browser. Chrome and Safari typically 
        offer higher quality voices than other browsers.
      </p>
      
      <label>
        Speed
        <input 
          type="range" 
          min="0.5" 
          max="2" 
          step="0.1"
          value={settings.rate}
          onChange={e => setSettings({ ...settings, rate: parseFloat(e.target.value) })}
        />
        {settings.rate}x
      </label>
    </div>
  );
}
```

---

## Privacy Considerations

### Data Flow Disclosure

Article content is sent to Groq (Llama 3.1 8B) for text preprocessing when narration is generated. This should be disclosed in the privacy policy:

> **Audio Narration**: When you use the narration feature, article content is sent to our text processing provider (Groq) to prepare it for text-to-speech. The actual audio is generated on your device using your browser's built-in speech synthesis. Narration text is cached on our servers to avoid repeated processing.

### Privacy Policy Updates

Add to existing privacy policy:

```markdown
## Third-Party Services

### Text Processing (Groq)
When you use the audio narration feature, article content is sent to Groq 
to convert it into speakable text. This processing expands abbreviations, 
formats numbers for speech, and improves pronunciation. The processed text 
is cached on our servers. Audio generation happens entirely on your device.

Groq's privacy policy: https://groq.com/privacy-policy/
```

---

## Feature Detection

Check for required APIs before showing narration controls:

```typescript
function isNarrationSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    'SpeechSynthesisUtterance' in window
  );
}

function isMediaSessionSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'mediaSession' in navigator
  );
}

// In React component
function NarrationControls({ article }: { article: Article }) {
  if (!isNarrationSupported()) {
    return null; // Don't render controls in unsupported browsers
  }

  // ... render playback controls
}
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `p` | Toggle play/pause |
| `Shift+N` | Skip to next paragraph |
| `Shift+P` | Skip to previous paragraph |

These integrate with the existing keyboard navigation system.

---

## Known Limitations

### Web Platform Constraints

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| **Background playback** | Audio stops when tab is backgrounded on mobile | Future: Capacitor wrapper with foreground service |
| **Voice quality variance** | Some browsers have poor voices | Show quality warning, recommend Chrome/Safari |
| **No offline narration** | Requires network to generate narration text | Cache aggressively; consider pre-generating for saved articles |

### Browser Support

| Browser | Voice Quality | Background Play | Notes |
|---------|--------------|-----------------|-------|
| Chrome (macOS) | Excellent | Tab must be visible | Best experience |
| Safari (macOS) | Excellent | Tab must be visible | Native voices |
| Chrome (Windows) | Good | Tab must be visible | Microsoft voices |
| Chrome (Android) | Good | Limited | Stops on screen lock |
| Safari (iOS) | Good | Limited | Better to use native iOS features |
| Firefox | Poor | Tab must be visible | Limited voice selection |

---

## Future Enhancements

### Phase 2: Highlighting and Sync (Not in v1)

**Sentence highlighting**: Show which sentence is currently being spoken by mapping paragraph indices back to original content positions.

**Cross-device sync**: Save `playback_paragraph_index` to server, allowing users to start on desktop and continue on mobile.

**Implementation notes:**
- Store paragraph mapping in `narration_paragraph_map` JSONB column
- Sync position on pause/stop and periodically during playback
- Handle conflicts by preferring most recent update

### Phase 3: Native App

**Capacitor wrapper** to enable:
- Background audio playback
- Lock screen controls (beyond Media Session API)
- Better voice access on mobile
- Offline support with pre-downloaded narration

---

## Metrics

```typescript
// Narration usage
narration_generated_total{cached="true|false"}
narration_playback_started_total
narration_playback_completed_total
narration_playback_duration_seconds

// Quality signals  
narration_generation_duration_seconds
narration_generation_errors_total{error_type}

// User preferences
narration_voice_selected{voice_name, browser}
narration_rate_setting{bucket}  // 0.5-0.75, 0.75-1.0, 1.0-1.25, etc.
```

---

## Implementation Checklist

### MVP (v1)

- [ ] Database migration: add narration columns to entries and saved_articles
  - `content_narration`, `narration_generated_at`
  - `narration_error`, `narration_error_at` (for error tracking/retry)
- [ ] Groq integration for text preprocessing
- [ ] tRPC endpoint for narration generation (supports entries and saved articles)
- [ ] Error handling with fallback to plain text, retry after 1 hour
- [ ] Web Speech API wrapper with paragraph-based playback
- [ ] Feature detection (hide controls in unsupported browsers)
- [ ] Media Session API integration for keyboard/OS controls
- [ ] Voice selector in settings with preview
- [ ] Play/pause/skip controls in article view
- [ ] Keyboard shortcuts (`p` play/pause, `Shift+N/P` skip)
- [ ] Privacy policy update
- [ ] Basic metrics

### Future (v2+)

- [ ] Sentence-level highlighting
- [ ] Cross-device playback sync
- [ ] Capacitor wrapper for background audio
- [ ] Pre-generation for starred/saved articles
- [ ] Playback speed presets (1x, 1.25x, 1.5x, 2x)
- [ ] Skip silence option

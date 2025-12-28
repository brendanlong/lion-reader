# Enhanced TTS Voices Design

## Overview

The Web Speech API provides varying voice quality across browsers. Chrome and Safari offer high-quality voices, but Firefox and some other browsers have poor options. This feature adds Piper TTS as an optional alternative, running entirely in the browser via WebAssembly.

### Design Principles

1. **Browser voices remain default**: Native voices work well on Chrome/Safari and require no download
2. **On-demand loading**: Voice models are downloaded only when selected (~30-60 MB each)
3. **Curated selection**: Offer 3-5 quality voices rather than overwhelming users with 900+ options
4. **Battery-conscious**: WASM-only (no WebGPU) for better mobile battery life
5. **Graceful degradation**: Fall back to browser voices if Piper fails to load

---

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Voice Selection Flow                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  User opens Narration Settings                                           │
│       │                                                                  │
│       ├──► "Browser Voices" section (default)                           │
│       │         └── Native SpeechSynthesis voices                       │
│       │                                                                  │
│       └──► "Enhanced Voices" section                                    │
│                 │                                                        │
│                 ├── First time: Download WASM runtime (~400 KB)         │
│                 │                                                        │
│                 └── User selects voice:                                 │
│                       │                                                  │
│                       └── Download voice model (~30-60 MB)              │
│                           └── Cached in IndexedDB                       │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Playback Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│ Narration Text  │────▶│  TTS Provider   │────▶│   Audio Output  │
│ (from LLM)      │     │  (abstraction)  │     │                 │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
           ┌────────▼────────┐       ┌────────▼────────┐
           │  Browser TTS    │       │   Piper TTS     │
           │  Provider       │       │   Provider      │
           │                 │       │                 │
           │ Web Speech API  │       │ ONNX + WASM     │
           │ (default)       │       │ (enhanced)      │
           └─────────────────┘       └─────────────────┘
```

### Component Responsibilities

| Component                 | Responsibility                                   |
| ------------------------- | ------------------------------------------------ |
| **TTSProvider interface** | Unified API for generating speech                |
| **BrowserTTSProvider**    | Wraps Web Speech API (existing behavior)         |
| **PiperTTSProvider**      | Wraps piper-tts-web library                      |
| **VoiceManager**          | Handles voice discovery, download, caching       |
| **Settings UI**           | Voice selection with preview and download status |

---

## Voice Selection

### Curated Voice List

Rather than exposing all 900+ Piper voices, we offer a curated selection:

| Voice ID              | Name    | Quality | Size   | Accent | Notes          |
| --------------------- | ------- | ------- | ------ | ------ | -------------- |
| `en_US-lessac-medium` | "Alex"  | Medium  | ~50 MB | US     | Natural, clear |
| `en_US-amy-low`       | "Amy"   | Low     | ~17 MB | US     | Fast, smaller  |
| `en_US-ryan-medium`   | "Ryan"  | Medium  | ~50 MB | US     | Male voice     |
| `en_GB-alba-medium`   | "Alba"  | Medium  | ~50 MB | UK     | British accent |
| `en_AU-karen-medium`  | "Karen" | Medium  | ~50 MB | AU     | Australian     |

### Voice Metadata

```typescript
interface EnhancedVoice {
  id: string; // e.g., "en_US-lessac-medium"
  displayName: string; // e.g., "Alex (US)"
  description: string; // e.g., "Clear, natural American voice"
  language: string; // e.g., "en-US"
  gender: "male" | "female";
  quality: "low" | "medium" | "high";
  sizeBytes: number; // For download progress
  sampleUrl?: string; // Optional audio sample URL
}

const ENHANCED_VOICES: EnhancedVoice[] = [
  {
    id: "en_US-lessac-medium",
    displayName: "Alex (US)",
    description: "Clear, natural American voice",
    language: "en-US",
    gender: "female",
    quality: "medium",
    sizeBytes: 50 * 1024 * 1024,
  },
  // ... more voices
];
```

---

## Storage & Caching

### IndexedDB Schema

Voice models are cached in IndexedDB for persistence across sessions:

```typescript
interface VoiceCache {
  voiceId: string; // Primary key, e.g., "en_US-lessac-medium"
  modelData: ArrayBuffer; // The .onnx model file
  configData: string; // The .onnx.json config file
  downloadedAt: number; // Timestamp for cache management
  version: string; // Model version for cache invalidation
}
```

### Cache Management

- **Storage limit**: Warn users if total cached voices exceed 200 MB
- **Cache invalidation**: Check model version on app update
- **Manual cleanup**: Allow users to delete cached voices in settings

---

## TTS Provider Interface

### Unified API

```typescript
interface TTSProvider {
  /** Provider identifier */
  readonly id: "browser" | "piper";

  /** Human-readable name */
  readonly name: string;

  /** Check if provider is available */
  isAvailable(): boolean;

  /** Get available voices for this provider */
  getVoices(): Promise<TTSVoice[]>;

  /** Speak text (returns audio data or void for streaming) */
  speak(text: string, options: SpeakOptions): Promise<void>;

  /** Stop current speech */
  stop(): void;

  /** Pause current speech */
  pause(): void;

  /** Resume paused speech */
  resume(): void;
}

interface TTSVoice {
  id: string;
  name: string;
  language: string;
  provider: "browser" | "piper";
  /** For enhanced voices: download status */
  downloadStatus?: "not-downloaded" | "downloading" | "downloaded";
  downloadProgress?: number;
}

interface SpeakOptions {
  voiceId: string;
  rate?: number; // 0.5 - 2.0
  pitch?: number; // 0.5 - 2.0
  onStart?: () => void;
  onEnd?: () => void;
  onParagraph?: (index: number) => void;
  onError?: (error: Error) => void;
}
```

### Browser TTS Provider

Wraps existing Web Speech API implementation:

```typescript
class BrowserTTSProvider implements TTSProvider {
  readonly id = "browser";
  readonly name = "Browser Voices";

  isAvailable(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  async getVoices(): Promise<TTSVoice[]> {
    const voices = await waitForVoices();
    return voices.map((v) => ({
      id: v.voiceURI,
      name: v.name,
      language: v.lang,
      provider: "browser",
    }));
  }

  // ... existing Web Speech API implementation
}
```

### Piper TTS Provider

```typescript
class PiperTTSProvider implements TTSProvider {
  readonly id = "piper";
  readonly name = "Enhanced Voices";

  private engine: PiperTTSEngine | null = null;
  private audioContext: AudioContext | null = null;

  isAvailable(): boolean {
    // Check for required browser features
    return typeof window !== "undefined" && "AudioContext" in window && "indexedDB" in window;
  }

  async getVoices(): Promise<TTSVoice[]> {
    const downloadedVoices = await this.getDownloadedVoices();

    return ENHANCED_VOICES.map((v) => ({
      id: v.id,
      name: v.displayName,
      language: v.language,
      provider: "piper",
      downloadStatus: downloadedVoices.has(v.id) ? "downloaded" : "not-downloaded",
    }));
  }

  async downloadVoice(voiceId: string, onProgress?: (progress: number) => void): Promise<void> {
    // Download from HuggingFace with progress tracking
    // Store in IndexedDB
  }

  async speak(text: string, options: SpeakOptions): Promise<void> {
    // Ensure voice is downloaded
    // Generate audio with Piper
    // Play through AudioContext
  }
}
```

---

## Settings UI

### Updated Settings Schema

```typescript
interface NarrationSettings {
  enabled: boolean;

  /** Which TTS provider to use */
  provider: "browser" | "piper";

  /** Voice ID (interpretation depends on provider) */
  voiceId: string | null;

  rate: number;
  pitch: number;
}
```

### Settings Component

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Narration Settings                                                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Voice Provider                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ ○ Browser Voices (default)                                          ││
│  │   Uses your browser's built-in text-to-speech                       ││
│  │                                                                      ││
│  │ ○ Enhanced Voices                                                   ││
│  │   Higher quality voices (requires download)                         ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│  [If Browser Voices selected]                                            │
│  Voice: [Samantha (en-US)           ▼]  [▶ Preview]                     │
│                                                                          │
│  [If Enhanced Voices selected]                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │ Alex (US) - Clear, natural American voice                           ││
│  │ [██████████████░░░░░░] 75% (38 MB / 50 MB)                          ││
│  │                                                                      ││
│  │ ○ Amy (US) - Fast, smaller download                    [Download]   ││
│  │   17 MB                                                              ││
│  │                                                                      ││
│  │ ○ Ryan (US) - Male voice                               [Download]   ││
│  │   50 MB                                                              ││
│  │                                                                      ││
│  │ ● Alba (UK) - British accent                           [▶ Preview]  ││
│  │   ✓ Downloaded                                                       ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│  Speed: [━━━━━━━━━●━━━━━] 1.25x                                         │
│                                                                          │
│  Storage used: 67 MB (2 voices)                    [Manage Storage]     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Download Flow

### Voice Download Process

```typescript
async function downloadVoice(
  voiceId: string,
  onProgress: (progress: number) => void
): Promise<void> {
  const voice = ENHANCED_VOICES.find((v) => v.id === voiceId);
  if (!voice) throw new Error(`Unknown voice: ${voiceId}`);

  // Construct HuggingFace URLs
  const [lang, region] = voice.language.split("-");
  const baseUrl = `https://huggingface.co/rhasspy/piper-voices/resolve/main`;
  const modelPath = `${lang}/${lang}_${region}/${voiceId.split("-")[1]}/${voice.quality}`;

  const modelUrl = `${baseUrl}/${modelPath}/${voiceId}.onnx`;
  const configUrl = `${baseUrl}/${modelPath}/${voiceId}.onnx.json`;

  // Download with progress tracking
  const modelData = await fetchWithProgress(modelUrl, (loaded, total) => {
    onProgress(loaded / total);
  });

  const configData = await fetch(configUrl).then((r) => r.text());

  // Store in IndexedDB
  await voiceCache.put({
    voiceId,
    modelData,
    configData,
    downloadedAt: Date.now(),
    version: "1.0",
  });
}
```

### Offline Support

Once downloaded, voices work offline:

```typescript
async function loadVoice(voiceId: string): Promise<PiperVoiceData> {
  // Try IndexedDB first
  const cached = await voiceCache.get(voiceId);
  if (cached) {
    return {
      model: cached.modelData,
      config: JSON.parse(cached.configData),
    };
  }

  throw new Error(`Voice ${voiceId} not downloaded`);
}
```

---

## Integration with ArticleNarrator

### Updated ArticleNarrator

```typescript
class ArticleNarrator {
  private provider: TTSProvider;
  private paragraphs: string[] = [];
  private currentIndex = 0;

  constructor(provider: TTSProvider) {
    this.provider = provider;
  }

  async loadArticle(narrationText: string) {
    this.paragraphs = narrationText
      .split(/\n\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    this.currentIndex = 0;
  }

  async play(voiceId: string, options: PlaybackOptions = {}) {
    if (this.currentIndex >= this.paragraphs.length) return;

    await this.provider.speak(this.paragraphs[this.currentIndex], {
      voiceId,
      rate: options.rate,
      pitch: options.pitch,
      onEnd: () => {
        this.currentIndex++;
        if (this.currentIndex < this.paragraphs.length) {
          this.play(voiceId, options);
        }
      },
    });
  }

  // ... pause, resume, stop, skip methods
}
```

### Provider Selection

```typescript
function useTTSProvider(): TTSProvider {
  const [settings] = useNarrationSettings();

  return useMemo(() => {
    if (settings.provider === "piper") {
      const piper = new PiperTTSProvider();
      if (piper.isAvailable()) {
        return piper;
      }
      // Fall back to browser if Piper unavailable
    }
    return new BrowserTTSProvider();
  }, [settings.provider]);
}
```

---

## Performance Considerations

### Battery Impact

- **WASM-only**: Piper uses ONNX Runtime WASM, not WebGPU
- **Research shows**: WASM uses 20-30% less energy than JavaScript
- **No GPU spin-up**: Avoids discrete GPU activation on laptops
- **Chunked processing**: Generate audio paragraph-by-paragraph to avoid blocking

### Memory Usage

- **Lazy loading**: Don't load Piper engine until user selects enhanced voice
- **Model unloading**: Unload models after idle period (e.g., 5 minutes)
- **Audio streaming**: Stream audio output rather than buffering entire article

### Initial Load

- **Code splitting**: Piper library loaded only when needed (~400 KB)
- **Progressive enhancement**: App works immediately with browser voices
- **Background download**: Voice downloads don't block UI

---

## Error Handling

### Download Errors

```typescript
try {
  await downloadVoice(voiceId, onProgress);
} catch (error) {
  if (error.name === "QuotaExceededError") {
    showError("Not enough storage space. Try deleting unused voices.");
  } else if (error.message.includes("NetworkError")) {
    showError("Download failed. Check your connection and try again.");
  } else {
    showError("Failed to download voice. Using browser voice instead.");
    fallbackToBrowserVoice();
  }
}
```

### Playback Errors

```typescript
try {
  await piperProvider.speak(text, options);
} catch (error) {
  console.error("Piper playback failed:", error);

  // Automatic fallback to browser TTS
  const browserProvider = new BrowserTTSProvider();
  await browserProvider.speak(text, {
    ...options,
    voiceId: getBestBrowserVoice(),
  });

  showToast("Enhanced voice unavailable. Using browser voice.");
}
```

---

## Metrics

```typescript
// Voice selection
enhanced_voice_selected_total{voice_id}
enhanced_voice_download_started_total{voice_id}
enhanced_voice_download_completed_total{voice_id}
enhanced_voice_download_failed_total{voice_id, error_type}

// Playback
narration_playback_started_total{provider="browser|piper"}
narration_playback_completed_total{provider}
narration_playback_duration_seconds{provider}

// Storage
enhanced_voices_storage_bytes
enhanced_voices_cached_count
```

---

## Future Enhancements

### Phase 2: More Voices

- Add voices for other languages (Spanish, French, German, etc.)
- Allow users to browse and download from full Piper catalog
- Implement voice search/filter

### Phase 3: Voice Quality Options

- Offer low/medium/high quality variants of each voice
- Let users choose based on storage/quality tradeoff

### Phase 4: Kokoro Integration

- Add Kokoro as "Premium" quality option (WebGPU when available)
- Automatic WebGPU detection and fallback to WASM
- Warn users about battery impact on mobile

---

## Implementation Checklist

### PR 1: TTS Provider Abstraction

- [ ] Create `TTSProvider` interface
- [ ] Implement `BrowserTTSProvider` wrapping existing code
- [ ] Update `ArticleNarrator` to use provider interface
- [ ] Add provider selection to settings schema
- [ ] Migrate existing code without behavior change

### PR 2: Piper Infrastructure

- [ ] Add piper-tts-web dependency
- [ ] Create IndexedDB schema for voice caching
- [ ] Implement `VoiceCache` class for storage operations
- [ ] Implement voice download with progress tracking
- [ ] Add curated voice metadata

### PR 3: Piper TTS Provider

- [ ] Implement `PiperTTSProvider` class
- [ ] Handle audio generation and playback via AudioContext
- [ ] Implement paragraph-based playback matching existing behavior
- [ ] Add fallback to browser TTS on error

### PR 4: Settings UI

- [ ] Add provider toggle (Browser/Enhanced) to settings
- [ ] Build voice list with download status indicators
- [ ] Implement download progress UI
- [ ] Add preview functionality for enhanced voices
- [ ] Add storage management section

### PR 5: Polish & Metrics

- [ ] Add metrics for voice selection and downloads
- [ ] Implement storage cleanup UI
- [ ] Add error toast notifications
- [ ] Write integration tests
- [ ] Update documentation

/**
 * Background Audio Player
 *
 * A streaming audio player designed for background playback on mobile devices.
 * Uses HTMLAudioElement instead of AudioContext to enable:
 * - Android media notification controls
 * - Background playback when app is not in foreground
 * - Media Session API integration
 *
 * Key architecture:
 * - Generates audio one paragraph at a time via Piper TTS
 * - Encodes to WebM/Opus format using WebCodecs
 * - Plays through HTMLAudioElement
 * - Buffers ahead while playing to maintain continuous playback
 * - Keeps JS execution alive during playback (audio exemption from throttling)
 *
 * @module narration/background-audio-player
 */

import { splitIntoSentences } from "./sentence-splitter";
import {
  encodeAudioBuffersToWebM,
  revokeAudioUrl,
  isAudioEncoderSupported,
  type EncodedAudio,
} from "./audio-encoder";

/**
 * Playback position tracking.
 */
export interface BackgroundPlaybackPosition {
  /** Current paragraph index */
  paragraph: number;
  /** Progress within paragraph (0-1) */
  progress: number;
}

/**
 * Playback status.
 */
export type BackgroundPlaybackStatus = "idle" | "loading" | "playing" | "paused" | "buffering";

/**
 * Callbacks for playback events.
 */
export interface BackgroundPlayerCallbacks {
  /** Called when playback status changes */
  onStatusChange?: (status: BackgroundPlaybackStatus) => void;
  /** Called when paragraph changes */
  onParagraphChange?: (paragraphIndex: number, totalParagraphs: number) => void;
  /** Called when an error occurs */
  onError?: (error: Error) => void;
  /** Called when playback reaches the end */
  onEnd?: () => void;
}

/**
 * Configuration for audio generation.
 */
export interface BackgroundPlayerConfig {
  /** Voice ID to use for TTS */
  voiceId: string;
  /** Playback rate (1.0 = normal) */
  rate: number;
  /** Gap between sentences in seconds */
  sentenceGapSeconds: number;
}

/**
 * Cached audio for a paragraph.
 */
interface ParagraphAudioCache {
  /** The encoded WebM audio */
  encoded: EncodedAudio;
  /** Sentence boundaries (cumulative time in seconds) */
  sentenceBoundaries: number[];
}

/**
 * Function type for generating audio from text.
 */
type GenerateAudioFn = (text: string, voiceId: string) => Promise<AudioBuffer>;

/**
 * Background audio player for mobile-friendly TTS playback.
 *
 * This player enables background audio playback by:
 * 1. Using HTMLAudioElement (not AudioContext)
 * 2. Encoding audio to WebM/Opus format
 * 3. Integrating with Media Session API
 */
export class BackgroundAudioPlayer {
  // Content
  private paragraphs: string[] = [];
  private cache = new Map<number, ParagraphAudioCache>();

  // State
  private status: BackgroundPlaybackStatus = "idle";
  private currentParagraph = 0;
  private callbacks: BackgroundPlayerCallbacks = {};
  private config: BackgroundPlayerConfig | null = null;

  // Audio element
  private audioElement: HTMLAudioElement | null = null;

  // Generation
  private generateAudio: GenerateAudioFn;
  private isGenerating = false;
  private generationCancelled = false;

  // Buffering state - which paragraphs are being/have been generated
  private generatingParagraphs = new Set<number>();
  private bufferAhead = 2; // How many paragraphs to buffer ahead

  constructor(generateAudio: GenerateAudioFn) {
    this.generateAudio = generateAudio;
  }

  /**
   * Check if background audio playback is supported.
   */
  static isSupported(): boolean {
    return typeof HTMLAudioElement !== "undefined" && isAudioEncoderSupported();
  }

  /**
   * Load paragraphs for playback.
   */
  load(paragraphs: string[]): void {
    this.stop();
    this.paragraphs = paragraphs;
    this.currentParagraph = 0;
    // Don't clear cache - allows reuse if same content
  }

  /**
   * Set callbacks for playback events.
   */
  setCallbacks(callbacks: BackgroundPlayerCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Set audio generation config.
   */
  setConfig(config: BackgroundPlayerConfig): void {
    this.config = config;
  }

  /**
   * Start or resume playback.
   */
  async play(): Promise<void> {
    if (!this.config) {
      throw new Error("Config not set");
    }

    if (this.paragraphs.length === 0) {
      return;
    }

    // Resume if paused
    if (this.status === "paused" && this.audioElement) {
      this.audioElement.play();
      this.setStatus("playing");
      return;
    }

    // Already playing
    if (this.status === "playing") {
      return;
    }

    // Start fresh playback
    this.generationCancelled = false;
    await this.startPlaybackFromParagraph(this.currentParagraph);
  }

  /**
   * Pause playback.
   */
  pause(): void {
    if (this.status !== "playing") return;

    if (this.audioElement) {
      this.audioElement.pause();
    }
    this.setStatus("paused");
  }

  /**
   * Stop playback and reset to beginning.
   */
  stop(): void {
    this.generationCancelled = true;
    this.isGenerating = false;
    this.generatingParagraphs.clear();

    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.src = "";
      this.audioElement = null;
    }

    this.currentParagraph = 0;
    this.setStatus("idle");
  }

  /**
   * Skip to the next paragraph.
   */
  async skipForward(): Promise<void> {
    if (this.currentParagraph >= this.paragraphs.length - 1) {
      this.stop();
      this.callbacks.onEnd?.();
      return;
    }

    const wasPlaying = this.status === "playing" || this.status === "buffering";
    this.currentParagraph++;

    if (wasPlaying) {
      // Cancel current generation and start fresh from new position
      this.generationCancelled = true;
      if (this.audioElement) {
        this.audioElement.pause();
      }
      this.generationCancelled = false;
      await this.startPlaybackFromParagraph(this.currentParagraph);
    } else {
      this.notifyParagraphChange();
    }
  }

  /**
   * Skip to the previous paragraph.
   */
  async skipBackward(): Promise<void> {
    const wasPlaying = this.status === "playing" || this.status === "buffering";
    this.currentParagraph = Math.max(0, this.currentParagraph - 1);

    if (wasPlaying) {
      this.generationCancelled = true;
      if (this.audioElement) {
        this.audioElement.pause();
      }
      this.generationCancelled = false;
      await this.startPlaybackFromParagraph(this.currentParagraph);
    } else {
      this.notifyParagraphChange();
    }
  }

  /**
   * Get current paragraph index.
   */
  getCurrentParagraph(): number {
    return this.currentParagraph;
  }

  /**
   * Get current status.
   */
  getStatus(): BackgroundPlaybackStatus {
    return this.status;
  }

  /**
   * Clear the audio cache and free memory.
   */
  clearCache(): void {
    for (const cached of this.cache.values()) {
      revokeAudioUrl(cached.encoded.url);
    }
    this.cache.clear();
  }

  /**
   * Start playback from a specific paragraph.
   */
  private async startPlaybackFromParagraph(paragraphIndex: number): Promise<void> {
    if (!this.config) return;

    this.currentParagraph = paragraphIndex;
    this.notifyParagraphChange();

    // Check if we have cached audio
    const cached = this.cache.get(paragraphIndex);
    if (cached) {
      this.playEncodedAudio(cached.encoded, paragraphIndex);
      this.startBufferingAhead(paragraphIndex + 1);
      return;
    }

    // Need to generate
    this.setStatus("loading");

    try {
      const encoded = await this.generateParagraphAudio(paragraphIndex);
      if (this.generationCancelled) return;

      // Start playback
      this.playEncodedAudio(encoded, paragraphIndex);

      // Start buffering ahead
      this.startBufferingAhead(paragraphIndex + 1);
    } catch (error) {
      if (!this.generationCancelled) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        this.setStatus("idle");
      }
    }
  }

  /**
   * Generate and encode audio for a paragraph.
   */
  private async generateParagraphAudio(paragraphIndex: number): Promise<EncodedAudio> {
    if (!this.config) {
      throw new Error("Config not set");
    }

    // Check cache first
    const cached = this.cache.get(paragraphIndex);
    if (cached) {
      return cached.encoded;
    }

    // Mark as generating
    this.generatingParagraphs.add(paragraphIndex);

    try {
      const paragraphText = this.paragraphs[paragraphIndex];
      const sentences = splitIntoSentences(paragraphText);

      // Generate audio for each sentence
      const sentenceBuffers: AudioBuffer[] = [];
      const sentenceBoundaries: number[] = [];
      let cumulativeTime = 0;

      for (const sentence of sentences) {
        if (this.generationCancelled) {
          throw new Error("Generation cancelled");
        }

        const buffer = await this.generateAudio(sentence, this.config.voiceId);
        sentenceBuffers.push(buffer);

        cumulativeTime += buffer.duration;
        sentenceBoundaries.push(cumulativeTime);

        // Add gap time (except for last sentence)
        if (sentences.indexOf(sentence) < sentences.length - 1) {
          cumulativeTime += this.config.sentenceGapSeconds;
        }
      }

      // Encode to WebM
      const encoded = await encodeAudioBuffersToWebM(
        sentenceBuffers,
        this.config.sentenceGapSeconds
      );

      // Cache it
      this.cache.set(paragraphIndex, { encoded, sentenceBoundaries });

      return encoded;
    } finally {
      this.generatingParagraphs.delete(paragraphIndex);
    }
  }

  /**
   * Play encoded audio through HTMLAudioElement.
   */
  private playEncodedAudio(encoded: EncodedAudio, paragraphIndex: number): void {
    // Create or reuse audio element
    if (!this.audioElement) {
      this.audioElement = new Audio();
    }

    // Set playback rate
    if (this.config) {
      this.audioElement.playbackRate = this.config.rate;
    }

    // Set source
    this.audioElement.src = encoded.url;

    // Handle playback end
    this.audioElement.onended = () => {
      this.onParagraphEnded(paragraphIndex);
    };

    // Handle errors
    this.audioElement.onerror = () => {
      const error = new Error(
        `Audio playback error: ${this.audioElement?.error?.message || "Unknown error"}`
      );
      this.callbacks.onError?.(error);
      this.setStatus("idle");
    };

    // Start playing
    this.audioElement
      .play()
      .then(() => {
        this.setStatus("playing");
      })
      .catch((error) => {
        // Autoplay may be blocked
        this.callbacks.onError?.(error);
        this.setStatus("paused");
      });
  }

  /**
   * Handle when a paragraph finishes playing.
   */
  private onParagraphEnded(paragraphIndex: number): void {
    // Move to next paragraph
    const nextParagraph = paragraphIndex + 1;

    if (nextParagraph >= this.paragraphs.length) {
      // End of all content
      this.currentParagraph = 0;
      this.setStatus("idle");
      this.callbacks.onEnd?.();
      return;
    }

    // Play next paragraph
    this.currentParagraph = nextParagraph;
    this.notifyParagraphChange();

    const cached = this.cache.get(nextParagraph);
    if (cached) {
      // Play immediately from cache
      this.playEncodedAudio(cached.encoded, nextParagraph);
      this.startBufferingAhead(nextParagraph + 1);
    } else {
      // Need to generate - shouldn't happen if buffering worked
      this.setStatus("buffering");
      this.generateParagraphAudio(nextParagraph)
        .then((encoded) => {
          if (!this.generationCancelled) {
            this.playEncodedAudio(encoded, nextParagraph);
            this.startBufferingAhead(nextParagraph + 1);
          }
        })
        .catch((error) => {
          if (!this.generationCancelled) {
            this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
            this.setStatus("idle");
          }
        });
    }
  }

  /**
   * Start buffering paragraphs ahead of current position.
   */
  private startBufferingAhead(startIndex: number): void {
    // Buffer the next N paragraphs
    for (let i = 0; i < this.bufferAhead; i++) {
      const paragraphIndex = startIndex + i;

      // Stop if we've reached the end
      if (paragraphIndex >= this.paragraphs.length) {
        break;
      }

      // Skip if already cached or generating
      if (this.cache.has(paragraphIndex) || this.generatingParagraphs.has(paragraphIndex)) {
        continue;
      }

      // Generate in background (don't await)
      this.generateParagraphAudio(paragraphIndex).catch((error) => {
        // Log but don't fail - we'll retry when needed
        console.warn(`Background buffering failed for paragraph ${paragraphIndex}:`, error);
      });
    }
  }

  /**
   * Update status and notify.
   */
  private setStatus(status: BackgroundPlaybackStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.callbacks.onStatusChange?.(status);
    }
  }

  /**
   * Notify paragraph change.
   */
  private notifyParagraphChange(): void {
    this.callbacks.onParagraphChange?.(this.currentParagraph, this.paragraphs.length);
  }

  /**
   * Get the HTMLAudioElement (for Media Session integration).
   */
  getAudioElement(): HTMLAudioElement | null {
    return this.audioElement;
  }
}

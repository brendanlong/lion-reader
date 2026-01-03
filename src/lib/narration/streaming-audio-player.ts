/**
 * Streaming Audio Player
 *
 * Manages sentence-level audio buffering and playback for Piper TTS.
 * Key features:
 * - Generates sentences one at a time (CPU-friendly for mobile)
 * - Starts playback as soon as first sentence is ready
 * - Buffers by time: 10s of current paragraph + 10s of next paragraph
 * - Caches all audio for instant skip forward/backward
 * - Cancels buffering on skip to prioritize new position
 *
 * @module narration/streaming-audio-player
 */

import { splitIntoSentences } from "./sentence-splitter";
import { DEFAULT_SENTENCE_GAP_SECONDS, createSilence } from "./audio-buffer-utils";
import type { SpeakOptions } from "./types";

/**
 * Target buffer duration in seconds.
 * We try to stay at least this far ahead of playback.
 */
const TARGET_BUFFER_SECONDS = 10;

/**
 * Sentence audio with metadata.
 */
interface SentenceAudio {
  /** The audio buffer for this sentence */
  buffer: AudioBuffer;
  /** Duration in seconds */
  duration: number;
}

/**
 * Cached data for a paragraph.
 */
interface ParagraphCache {
  /** The paragraph text */
  text: string;
  /** Sentences split from the paragraph */
  sentences: string[];
  /** Audio buffer for each sentence (null = not yet generated) */
  audio: (SentenceAudio | null)[];
  /** Total duration of all generated audio in this paragraph */
  totalDuration: number;
}

/**
 * Current playback position.
 */
export interface PlaybackPosition {
  /** Current paragraph index */
  paragraph: number;
  /** Current sentence index within paragraph */
  sentence: number;
}

/**
 * Playback state.
 */
export type PlaybackStatus = "idle" | "playing" | "paused" | "buffering";

/**
 * Callbacks for playback events.
 */
export interface StreamingPlayerCallbacks {
  /** Called when playback status changes */
  onStatusChange?: (status: PlaybackStatus) => void;
  /** Called when position changes (paragraph or sentence) */
  onPositionChange?: (position: PlaybackPosition, totalParagraphs: number) => void;
  /** Called when an error occurs */
  onError?: (error: Error) => void;
  /** Called when playback reaches the end */
  onEnd?: () => void;
}

/**
 * Configuration for generating audio.
 */
export interface AudioGeneratorConfig {
  /** Voice ID to use */
  voiceId: string;
  /** Playback rate */
  rate: number;
  /** Gap between sentences in seconds */
  sentenceGapSeconds: number;
}

/**
 * Function type for generating audio from text.
 */
type GenerateAudioFn = (text: string, voiceId: string) => Promise<AudioBuffer>;

/**
 * Function type for playing an audio buffer.
 */
type PlayBufferFn = (buffer: AudioBuffer, options: SpeakOptions) => void;

/**
 * Function type for stopping playback.
 */
type StopFn = () => void;

/**
 * Function type for pausing playback.
 */
type PauseFn = () => void;

/**
 * Function type for resuming playback.
 */
type ResumeFn = () => void;

/**
 * Function type for getting the AudioContext.
 */
type GetAudioContextFn = () => AudioContext;

/**
 * Streaming audio player that manages sentence-level buffering and playback.
 */
export class StreamingAudioPlayer {
  private paragraphs: string[] = [];
  private cache: Map<number, ParagraphCache> = new Map();
  private position: PlaybackPosition = { paragraph: 0, sentence: 0 };
  private status: PlaybackStatus = "idle";
  private callbacks: StreamingPlayerCallbacks = {};
  private config: AudioGeneratorConfig | null = null;

  // Provider functions
  private generateAudio: GenerateAudioFn;
  private playBuffer: PlayBufferFn;
  private stopPlayback: StopFn;
  private pausePlayback: PauseFn;
  private resumePlayback: ResumeFn;
  private getAudioContext: GetAudioContextFn;

  // Buffering state
  private isBuffering = false;
  private bufferingCancelled = false;
  private currentGenerationParagraph: number | null = null;
  private currentGenerationSentence: number | null = null;

  // Playback state
  private isPaused = false;
  private currentSentenceEndCallback: (() => void) | null = null;

  constructor(
    generateAudio: GenerateAudioFn,
    playBuffer: PlayBufferFn,
    stopPlayback: StopFn,
    pausePlayback: PauseFn,
    resumePlayback: ResumeFn,
    getAudioContext: GetAudioContextFn
  ) {
    this.generateAudio = generateAudio;
    this.playBuffer = playBuffer;
    this.stopPlayback = stopPlayback;
    this.pausePlayback = pausePlayback;
    this.resumePlayback = resumePlayback;
    this.getAudioContext = getAudioContext;
  }

  /**
   * Load paragraphs for playback.
   */
  load(paragraphs: string[]): void {
    this.paragraphs = paragraphs;
    // Don't clear cache - we want to keep any pre-generated audio
    this.position = { paragraph: 0, sentence: 0 };
    this.setStatus("idle");
  }

  /**
   * Set callbacks for playback events.
   */
  setCallbacks(callbacks: StreamingPlayerCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Set audio generation config.
   */
  setConfig(config: AudioGeneratorConfig): void {
    this.config = config;
  }

  /**
   * Start or resume playback from current position.
   */
  async play(): Promise<void> {
    if (!this.config) {
      throw new Error("Config not set");
    }

    if (this.paragraphs.length === 0) {
      return;
    }

    if (this.status === "paused") {
      this.isPaused = false;
      this.resumePlayback();
      this.setStatus("playing");
      return;
    }

    if (this.status === "playing") {
      return;
    }

    this.isPaused = false;
    await this.startPlaybackFrom(this.position);
  }

  /**
   * Pause playback.
   */
  pause(): void {
    if (this.status !== "playing") return;

    this.isPaused = true;
    this.pausePlayback();
    this.setStatus("paused");
  }

  /**
   * Stop playback and reset to beginning.
   */
  stop(): void {
    this.cancelBuffering();
    this.stopPlayback();
    this.isPaused = false;
    this.position = { paragraph: 0, sentence: 0 };
    this.setStatus("idle");
    this.notifyPositionChange();
  }

  /**
   * Skip to the next paragraph.
   */
  async skipForward(): Promise<void> {
    if (this.position.paragraph >= this.paragraphs.length - 1) {
      // At last paragraph - stop
      this.stop();
      this.callbacks.onEnd?.();
      return;
    }

    this.cancelBuffering();
    this.stopPlayback();

    this.position = {
      paragraph: this.position.paragraph + 1,
      sentence: 0,
    };

    if (this.status === "playing" || this.status === "buffering") {
      await this.startPlaybackFrom(this.position);
    } else {
      this.notifyPositionChange();
    }
  }

  /**
   * Skip to the previous paragraph.
   */
  async skipBackward(): Promise<void> {
    this.cancelBuffering();
    this.stopPlayback();

    this.position = {
      paragraph: Math.max(0, this.position.paragraph - 1),
      sentence: 0,
    };

    if (this.status === "playing" || this.status === "buffering") {
      await this.startPlaybackFrom(this.position);
    } else {
      this.notifyPositionChange();
    }
  }

  /**
   * Get current playback position.
   */
  getPosition(): PlaybackPosition {
    return { ...this.position };
  }

  /**
   * Get current status.
   */
  getStatus(): PlaybackStatus {
    return this.status;
  }

  /**
   * Clear the audio cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get or create the cache entry for a paragraph.
   */
  private getOrCreateParagraphCache(paragraphIndex: number): ParagraphCache {
    let cached = this.cache.get(paragraphIndex);
    if (!cached) {
      const text = this.paragraphs[paragraphIndex];
      const sentences = splitIntoSentences(text);
      cached = {
        text,
        sentences,
        audio: new Array(sentences.length).fill(null),
        totalDuration: 0,
      };
      this.cache.set(paragraphIndex, cached);
    }
    return cached;
  }

  /**
   * Calculate buffered duration from a position to the end of the paragraph.
   */
  private getBufferedDurationInParagraph(paragraphIndex: number, fromSentence: number): number {
    const cached = this.cache.get(paragraphIndex);
    if (!cached) return 0;

    let duration = 0;
    for (let i = fromSentence; i < cached.audio.length; i++) {
      const audio = cached.audio[i];
      if (audio) {
        duration += audio.duration;
        // Add gap except for last sentence
        if (i < cached.audio.length - 1) {
          duration += this.config?.sentenceGapSeconds ?? DEFAULT_SENTENCE_GAP_SECONDS;
        }
      } else {
        // Stop counting at first unbuffered sentence
        break;
      }
    }
    return duration;
  }

  /**
   * Calculate total buffered duration for a paragraph.
   */
  private getTotalBufferedDurationInParagraph(paragraphIndex: number): number {
    return this.getBufferedDurationInParagraph(paragraphIndex, 0);
  }

  /**
   * Check if a sentence is buffered.
   */
  private isSentenceBuffered(paragraphIndex: number, sentenceIndex: number): boolean {
    const cached = this.cache.get(paragraphIndex);
    return cached?.audio[sentenceIndex] != null;
  }

  /**
   * Start playback from a specific position.
   */
  private async startPlaybackFrom(pos: PlaybackPosition): Promise<void> {
    if (!this.config) return;

    this.position = { ...pos };
    this.notifyPositionChange();

    // Check if we have audio for the first sentence
    const paragraphCache = this.getOrCreateParagraphCache(pos.paragraph);

    if (paragraphCache.audio[pos.sentence]) {
      // We have audio - start playing immediately
      this.setStatus("playing");
      this.playSentence(pos.paragraph, pos.sentence);
      // Start buffering in background
      this.startBuffering();
    } else {
      // Need to generate first sentence
      this.setStatus("buffering");
      await this.generateAndPlayFirstSentence(pos.paragraph, pos.sentence);
    }
  }

  /**
   * Generate the first sentence and start playing as soon as it's ready.
   */
  private async generateAndPlayFirstSentence(
    paragraphIndex: number,
    sentenceIndex: number
  ): Promise<void> {
    if (!this.config) return;

    const paragraphCache = this.getOrCreateParagraphCache(paragraphIndex);

    if (sentenceIndex >= paragraphCache.sentences.length) {
      // No more sentences in this paragraph
      if (paragraphIndex < this.paragraphs.length - 1) {
        // Move to next paragraph
        this.position = { paragraph: paragraphIndex + 1, sentence: 0 };
        this.notifyPositionChange();
        await this.generateAndPlayFirstSentence(paragraphIndex + 1, 0);
      } else {
        // End of all paragraphs
        this.setStatus("idle");
        this.callbacks.onEnd?.();
      }
      return;
    }

    // Mark as currently generating
    this.currentGenerationParagraph = paragraphIndex;
    this.currentGenerationSentence = sentenceIndex;
    this.bufferingCancelled = false;

    try {
      const sentenceText = paragraphCache.sentences[sentenceIndex];
      const buffer = await this.generateAudio(sentenceText, this.config.voiceId);

      // Check if we were cancelled
      if (this.bufferingCancelled) {
        return;
      }

      // Cache the audio
      paragraphCache.audio[sentenceIndex] = {
        buffer,
        duration: buffer.duration,
      };
      paragraphCache.totalDuration += buffer.duration;

      // Start playing if we're still at this position
      if (this.position.paragraph === paragraphIndex && this.position.sentence === sentenceIndex) {
        this.setStatus("playing");
        this.playSentence(paragraphIndex, sentenceIndex);
        // Start buffering in background
        this.startBuffering();
      }
    } catch (error) {
      if (!this.bufferingCancelled) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        this.setStatus("idle");
      }
    } finally {
      this.currentGenerationParagraph = null;
      this.currentGenerationSentence = null;
    }
  }

  /**
   * Play a specific sentence.
   */
  private playSentence(paragraphIndex: number, sentenceIndex: number): void {
    if (!this.config) return;

    const paragraphCache = this.cache.get(paragraphIndex);
    if (!paragraphCache) return;

    const audio = paragraphCache.audio[sentenceIndex];
    if (!audio) return;

    // Create a gap buffer if not the last sentence in paragraph
    const isLastInParagraph = sentenceIndex >= paragraphCache.sentences.length - 1;
    const isLastParagraph = paragraphIndex >= this.paragraphs.length - 1;

    // Calculate buffer to play (sentence + optional gap)
    let bufferToPlay = audio.buffer;
    const gapSeconds = this.config.sentenceGapSeconds;

    if (!isLastInParagraph && gapSeconds > 0) {
      // Append silence gap
      bufferToPlay = this.appendSilence(audio.buffer, gapSeconds);
    }

    this.playBuffer(bufferToPlay, {
      voiceId: this.config.voiceId,
      rate: this.config.rate,
      onEnd: () => {
        if (this.isPaused) return;

        // Move to next sentence or paragraph
        if (!isLastInParagraph) {
          // Next sentence in same paragraph
          this.position.sentence = sentenceIndex + 1;
          this.notifyPositionChange();
          this.playNextSentence();
        } else if (!isLastParagraph) {
          // Next paragraph
          this.position = { paragraph: paragraphIndex + 1, sentence: 0 };
          this.notifyPositionChange();
          this.playNextSentence();
        } else {
          // End of all content
          this.setStatus("idle");
          this.position = { paragraph: 0, sentence: 0 };
          this.callbacks.onEnd?.();
        }
      },
      onError: (error: Error) => {
        this.callbacks.onError?.(error);
        this.setStatus("idle");
      },
    });
  }

  /**
   * Play the next sentence, generating if needed.
   */
  private async playNextSentence(): Promise<void> {
    if (this.isPaused) return;

    const { paragraph, sentence } = this.position;

    if (paragraph >= this.paragraphs.length) {
      // Done
      this.setStatus("idle");
      this.callbacks.onEnd?.();
      return;
    }

    const paragraphCache = this.getOrCreateParagraphCache(paragraph);

    if (sentence >= paragraphCache.sentences.length) {
      // Move to next paragraph
      if (paragraph < this.paragraphs.length - 1) {
        this.position = { paragraph: paragraph + 1, sentence: 0 };
        this.notifyPositionChange();
        await this.playNextSentence();
      } else {
        // End
        this.setStatus("idle");
        this.position = { paragraph: 0, sentence: 0 };
        this.callbacks.onEnd?.();
      }
      return;
    }

    const audio = paragraphCache.audio[sentence];
    if (audio) {
      // Play immediately
      this.playSentence(paragraph, sentence);
    } else {
      // Need to generate - this shouldn't happen if buffering is working,
      // but handle it gracefully
      this.setStatus("buffering");
      await this.generateAndPlayFirstSentence(paragraph, sentence);
    }
  }

  /**
   * Append silence to an audio buffer.
   */
  private appendSilence(buffer: AudioBuffer, gapSeconds: number): AudioBuffer {
    const audioContext = this.getAudioContext();
    const silence = createSilence(
      audioContext,
      gapSeconds,
      buffer.sampleRate,
      buffer.numberOfChannels
    );

    const totalLength = buffer.length + silence.length;
    const combined = audioContext.createBuffer(
      buffer.numberOfChannels,
      totalLength,
      buffer.sampleRate
    );

    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const outputData = combined.getChannelData(channel);
      outputData.set(buffer.getChannelData(channel), 0);
      outputData.set(silence.getChannelData(channel), buffer.length);
    }

    return combined;
  }

  /**
   * Start background buffering.
   */
  private startBuffering(): void {
    if (this.isBuffering) return;
    this.isBuffering = true;
    this.bufferingCancelled = false;
    this.bufferLoop();
  }

  /**
   * Cancel any in-progress buffering.
   */
  private cancelBuffering(): void {
    this.bufferingCancelled = true;
    this.isBuffering = false;
  }

  /**
   * Main buffering loop - generates sentences one at a time.
   */
  private async bufferLoop(): Promise<void> {
    if (!this.config || this.bufferingCancelled) {
      this.isBuffering = false;
      return;
    }

    const { paragraph, sentence } = this.position;

    // Calculate how much is buffered ahead in current paragraph
    const currentBufferedDuration = this.getBufferedDurationInParagraph(paragraph, sentence);
    const currentParagraphCache = this.getOrCreateParagraphCache(paragraph);
    const currentParagraphFullyBuffered = currentParagraphCache.audio.every((a) => a != null);

    // Calculate how much is buffered in next paragraph
    const nextParagraph = paragraph + 1;
    const nextBufferedDuration =
      nextParagraph < this.paragraphs.length
        ? this.getTotalBufferedDurationInParagraph(nextParagraph)
        : TARGET_BUFFER_SECONDS; // Pretend next is full if no next

    // Decide what to buffer next
    let targetParagraph: number | null = null;
    let targetSentence: number | null = null;

    if (!currentParagraphFullyBuffered && currentBufferedDuration < TARGET_BUFFER_SECONDS) {
      // Buffer more of current paragraph
      targetParagraph = paragraph;
      // Find first unbuffered sentence
      for (let i = 0; i < currentParagraphCache.audio.length; i++) {
        if (!currentParagraphCache.audio[i]) {
          targetSentence = i;
          break;
        }
      }
    } else if (
      nextParagraph < this.paragraphs.length &&
      nextBufferedDuration < TARGET_BUFFER_SECONDS
    ) {
      // Buffer next paragraph
      targetParagraph = nextParagraph;
      const nextCache = this.getOrCreateParagraphCache(nextParagraph);
      // Find first unbuffered sentence
      for (let i = 0; i < nextCache.audio.length; i++) {
        if (!nextCache.audio[i]) {
          targetSentence = i;
          break;
        }
      }
    }

    if (targetParagraph === null || targetSentence === null) {
      // Nothing more to buffer
      this.isBuffering = false;
      return;
    }

    // Check if we're already generating this
    if (
      this.currentGenerationParagraph === targetParagraph &&
      this.currentGenerationSentence === targetSentence
    ) {
      // Already generating, wait a bit and check again
      await this.sleep(100);
      this.bufferLoop();
      return;
    }

    // Generate the sentence
    this.currentGenerationParagraph = targetParagraph;
    this.currentGenerationSentence = targetSentence;

    try {
      const paragraphCache = this.getOrCreateParagraphCache(targetParagraph);
      const sentenceText = paragraphCache.sentences[targetSentence];

      if (this.bufferingCancelled) {
        this.isBuffering = false;
        return;
      }

      const buffer = await this.generateAudio(sentenceText, this.config.voiceId);

      if (this.bufferingCancelled) {
        this.isBuffering = false;
        return;
      }

      // Cache it
      paragraphCache.audio[targetSentence] = {
        buffer,
        duration: buffer.duration,
      };
      paragraphCache.totalDuration += buffer.duration;

      // Continue buffering
      this.currentGenerationParagraph = null;
      this.currentGenerationSentence = null;
      this.bufferLoop();
    } catch (error) {
      console.error("Buffering error:", error);
      // Continue trying to buffer
      this.currentGenerationParagraph = null;
      this.currentGenerationSentence = null;
      if (!this.bufferingCancelled) {
        await this.sleep(500);
        this.bufferLoop();
      } else {
        this.isBuffering = false;
      }
    }
  }

  /**
   * Helper to sleep for a duration.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Update status and notify.
   */
  private setStatus(status: PlaybackStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.callbacks.onStatusChange?.(status);
    }
  }

  /**
   * Notify position change.
   */
  private notifyPositionChange(): void {
    this.callbacks.onPositionChange?.({ ...this.position }, this.paragraphs.length);
  }
}

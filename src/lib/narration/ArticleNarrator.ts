/**
 * ArticleNarrator
 *
 * A client-side class for paragraph-based article narration using the Web Speech API.
 * Provides playback controls, state management, and paragraph navigation.
 *
 * Note: Firefox has a known bug where `speechSynthesis.pause()` and
 * `speechSynthesis.resume()` don't work. This class implements a workaround
 * by using `cancel()` and restarting from the current paragraph position.
 *
 * Usage:
 * ```typescript
 * import { ArticleNarrator } from "@/lib/narration/ArticleNarrator";
 *
 * const narrator = new ArticleNarrator();
 * narrator.loadArticle("First paragraph.\n\nSecond paragraph.");
 * narrator.onStateChange((state) => console.log(state));
 * narrator.play();
 * ```
 *
 * @see https://bugzilla.mozilla.org/show_bug.cgi?id=1316808
 */

import { isFirefox } from "./feature-detection";
import {
  DEFAULT_RATE,
  DEFAULT_PITCH,
  MIN_RATE,
  MAX_RATE,
  MIN_PITCH,
  MAX_PITCH,
  clamp,
} from "./constants";

/**
 * Possible states for the narration playback.
 */
export type NarrationStatus = "idle" | "loading" | "playing" | "paused";

/**
 * Current state of the narration.
 */
export interface NarrationState {
  /** Current playback status */
  status: NarrationStatus;
  /** Index of the current paragraph (0-based) */
  currentParagraph: number;
  /** Total number of paragraphs in the loaded article */
  totalParagraphs: number;
  /** Currently selected voice for narration */
  selectedVoice: SpeechSynthesisVoice | null;
}

/**
 * Callback type for state change notifications.
 */
export type StateChangeCallback = (state: NarrationState) => void;

/**
 * ArticleNarrator provides paragraph-based narration for articles using the Web Speech API.
 *
 * Features:
 * - Loads article text and splits into paragraphs
 * - Play, pause, resume, and stop controls
 * - Skip forward/backward between paragraphs
 * - Auto-advances to next paragraph on completion
 * - Configurable voice, rate, and pitch
 * - State change notifications for UI updates
 */
export class ArticleNarrator {
  private paragraphs: string[] = [];
  private currentIndex = 0;
  private utterance: SpeechSynthesisUtterance | null = null;
  private status: NarrationStatus = "idle";
  private selectedVoice: SpeechSynthesisVoice | null = null;
  private rate: number = DEFAULT_RATE;
  private pitch: number = DEFAULT_PITCH;
  private stateChangeListeners: Set<StateChangeCallback> = new Set();

  /**
   * Flag to prevent handleUtteranceEnd from auto-advancing during skip operations.
   * This is needed because speechSynthesis.cancel() may fire onend asynchronously
   * after we've already set status back to "playing".
   */
  private isSkipping = false;

  /**
   * Cached Firefox detection result.
   * Firefox has broken pause/resume, so we use a workaround.
   */
  private readonly isFirefoxBrowser: boolean;

  /**
   * Creates a new ArticleNarrator instance.
   */
  constructor() {
    // Bind methods to ensure correct 'this' context when used as callbacks
    this.handleUtteranceEnd = this.handleUtteranceEnd.bind(this);
    this.handleUtteranceError = this.handleUtteranceError.bind(this);

    // Cache Firefox detection (checked once at construction)
    this.isFirefoxBrowser = isFirefox();
  }

  /**
   * Loads an article for narration by splitting the text into paragraphs.
   * Paragraphs are separated by double newlines.
   *
   * @param narrationText - The text content to narrate
   */
  loadArticle(narrationText: string): void {
    // Split by double newlines (paragraph breaks), trim, and filter empty
    this.paragraphs = narrationText
      .split(/\n\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    this.currentIndex = 0;
    this.stop(); // Reset any current playback
    this.setStatus("idle");
  }

  /**
   * Starts or resumes playback from the current paragraph.
   *
   * @param voice - Optional voice to use for narration
   * @param rate - Optional speech rate (0.5 to 2.0, default 1.0)
   * @param pitch - Optional speech pitch (0.5 to 2.0, default 1.0)
   */
  play(voice?: SpeechSynthesisVoice, rate?: number, pitch?: number): void {
    // Check if speech synthesis is available
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      console.warn("Speech synthesis is not supported in this browser");
      return;
    }

    // Handle empty or exhausted paragraphs
    if (this.paragraphs.length === 0) {
      return;
    }

    if (this.currentIndex >= this.paragraphs.length) {
      // Reset to beginning if we've reached the end
      this.currentIndex = 0;
    }

    // If currently paused, just resume
    if (this.status === "paused") {
      this.resume();
      return;
    }

    // Update settings if provided
    if (voice !== undefined) {
      this.selectedVoice = voice;
    }
    if (rate !== undefined) {
      this.rate = clamp(rate, MIN_RATE, MAX_RATE);
    }
    if (pitch !== undefined) {
      this.pitch = clamp(pitch, MIN_PITCH, MAX_PITCH);
    }

    this.speakCurrentParagraph();
  }

  /**
   * Pauses the current playback.
   *
   * Note: Firefox has a known bug where `speechSynthesis.pause()` doesn't work.
   * On Firefox, we use `cancel()` instead and remember the paragraph position
   * so we can restart from there on resume.
   */
  pause(): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }

    if (this.status === "playing") {
      // Set status BEFORE cancel/pause to prevent handleUtteranceEnd from auto-advancing
      this.setStatus("paused");

      if (this.isFirefoxBrowser) {
        // Firefox workaround: cancel instead of pause
        // We'll restart from the current paragraph on resume
        speechSynthesis.cancel();
        this.utterance = null;
      } else {
        speechSynthesis.pause();
      }
    }
  }

  /**
   * Resumes playback after a pause.
   *
   * Note: On Firefox, since we used `cancel()` instead of `pause()`,
   * we restart from the beginning of the current paragraph.
   */
  resume(): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }

    if (this.status === "paused") {
      if (this.isFirefoxBrowser) {
        // Firefox workaround: restart from current paragraph
        this.speakCurrentParagraph();
      } else {
        speechSynthesis.resume();
        this.setStatus("playing");
      }
    }
  }

  /**
   * Stops playback and resets to the beginning of the article.
   */
  stop(): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }

    // Set status BEFORE cancel to prevent handleUtteranceEnd from auto-advancing
    this.setStatus("idle");
    speechSynthesis.cancel();
    this.utterance = null;
    this.currentIndex = 0;
  }

  /**
   * Skips to the next paragraph.
   * If at the last paragraph, stops playback.
   */
  skipForward(): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }

    if (this.paragraphs.length === 0) {
      return;
    }

    // Set skip flag to prevent handleUtteranceEnd from auto-advancing
    // This is needed because cancel() may fire onend asynchronously
    this.isSkipping = true;
    speechSynthesis.cancel();
    this.utterance = null;

    // Move to next paragraph, but don't exceed bounds
    if (this.currentIndex < this.paragraphs.length - 1) {
      this.currentIndex++;
      this.speakCurrentParagraph();
    } else {
      // At the last paragraph, stop
      this.setStatus("idle");
    }

    // Clear skip flag after a small delay to handle async onend events
    setTimeout(() => {
      this.isSkipping = false;
    }, 50);
  }

  /**
   * Skips to the previous paragraph.
   * If at the first paragraph, restarts it.
   */
  skipBackward(): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }

    if (this.paragraphs.length === 0) {
      return;
    }

    // Set skip flag to prevent handleUtteranceEnd from auto-advancing
    // This is needed because cancel() may fire onend asynchronously
    this.isSkipping = true;
    speechSynthesis.cancel();
    this.utterance = null;

    // Move to previous paragraph
    this.currentIndex = Math.max(this.currentIndex - 1, 0);
    this.speakCurrentParagraph();

    // Clear skip flag after a small delay to handle async onend events
    setTimeout(() => {
      this.isSkipping = false;
    }, 50);
  }

  /**
   * Returns the current narration state.
   *
   * @returns Current state including status, paragraph info, and voice
   */
  getState(): NarrationState {
    return {
      status: this.status,
      currentParagraph: this.currentIndex,
      totalParagraphs: this.paragraphs.length,
      selectedVoice: this.selectedVoice,
    };
  }

  /**
   * Registers a callback to be notified when the state changes.
   *
   * @param callback - Function to call when state changes
   * @returns A function to unsubscribe the callback
   */
  onStateChange(callback: StateChangeCallback): () => void {
    this.stateChangeListeners.add(callback);

    // Return unsubscribe function
    return () => {
      this.stateChangeListeners.delete(callback);
    };
  }

  /**
   * Sets the voice to use for narration.
   *
   * @param voice - The SpeechSynthesisVoice to use
   */
  setVoice(voice: SpeechSynthesisVoice): void {
    this.selectedVoice = voice;
    this.notifyStateChange();
  }

  /**
   * Sets the speech rate.
   *
   * @param rate - Speech rate between 0.5 and 2.0
   */
  setRate(rate: number): void {
    this.rate = clamp(rate, MIN_RATE, MAX_RATE);
  }

  /**
   * Sets the speech pitch.
   *
   * @param pitch - Speech pitch between 0.5 and 2.0
   */
  setPitch(pitch: number): void {
    this.pitch = clamp(pitch, MIN_PITCH, MAX_PITCH);
  }

  /**
   * Gets the current speech rate.
   */
  getRate(): number {
    return this.rate;
  }

  /**
   * Gets the current speech pitch.
   */
  getPitch(): number {
    return this.pitch;
  }

  /**
   * Gets the current paragraph index.
   */
  getCurrentParagraphIndex(): number {
    return this.currentIndex;
  }

  /**
   * Gets the text of the current paragraph.
   */
  getCurrentParagraphText(): string | null {
    if (this.currentIndex >= 0 && this.currentIndex < this.paragraphs.length) {
      return this.paragraphs[this.currentIndex];
    }
    return null;
  }

  /**
   * Jumps to a specific paragraph index.
   *
   * @param index - The paragraph index to jump to
   */
  jumpToParagraph(index: number): void {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }

    if (index < 0 || index >= this.paragraphs.length) {
      return;
    }

    // Cancel current playback
    speechSynthesis.cancel();
    this.utterance = null;

    this.currentIndex = index;

    // If we were playing, continue playing from new position
    if (this.status === "playing" || this.status === "paused") {
      this.speakCurrentParagraph();
    } else {
      this.notifyStateChange();
    }
  }

  /**
   * Speaks the current paragraph.
   */
  private speakCurrentParagraph(): void {
    if (this.currentIndex >= this.paragraphs.length) {
      this.setStatus("idle");
      return;
    }

    const text = this.paragraphs[this.currentIndex];
    this.utterance = new SpeechSynthesisUtterance(text);

    // Configure utterance settings
    if (this.selectedVoice) {
      this.utterance.voice = this.selectedVoice;
    }
    this.utterance.rate = this.rate;
    this.utterance.pitch = this.pitch;

    // Set up event handlers
    this.utterance.onend = this.handleUtteranceEnd;
    this.utterance.onerror = this.handleUtteranceError;

    this.setStatus("playing");
    speechSynthesis.speak(this.utterance);
  }

  /**
   * Handles the end of an utterance, auto-advancing to next paragraph.
   */
  private handleUtteranceEnd(): void {
    // Don't auto-advance if we're skipping (skip operation handles index manually)
    if (this.isSkipping) {
      return;
    }

    // Don't auto-advance if we're not playing (e.g., paused or stopped)
    if (this.status !== "playing") {
      return;
    }

    this.currentIndex++;

    if (this.currentIndex < this.paragraphs.length) {
      // Auto-advance to next paragraph
      this.speakCurrentParagraph();
    } else {
      // Reached end of article
      this.utterance = null;
      this.setStatus("idle");
    }
  }

  /**
   * Handles errors during utterance playback.
   */
  private handleUtteranceError(event: SpeechSynthesisErrorEvent): void {
    // 'interrupted' and 'canceled' are not real errors - they happen when
    // we intentionally stop or skip
    if (event.error === "interrupted" || event.error === "canceled") {
      return;
    }

    console.error("Speech synthesis error:", event.error);
    this.setStatus("idle");
  }

  /**
   * Updates the status and notifies listeners.
   */
  private setStatus(newStatus: NarrationStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      this.notifyStateChange();
    } else {
      // Even if status hasn't changed, paragraph might have
      this.notifyStateChange();
    }
  }

  /**
   * Notifies all registered listeners of a state change.
   */
  private notifyStateChange(): void {
    const state = this.getState();
    for (const callback of this.stateChangeListeners) {
      try {
        callback(state);
      } catch (error) {
        console.error("Error in state change callback:", error);
      }
    }
  }
}

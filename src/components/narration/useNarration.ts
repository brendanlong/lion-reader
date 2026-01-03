/**
 * useNarration Hook
 *
 * Manages article narration state using either the Web Speech API (browser voices)
 * or Piper TTS (enhanced voices). Handles narration generation, playback controls,
 * and Media Session integration.
 *
 * Usage:
 * ```tsx
 * function ArticleView({ articleId }: { articleId: string }) {
 *   const narration = useNarration({ id: articleId, type: 'entry', title: 'Article Title', feedTitle: 'Feed' });
 *
 *   return (
 *     <NarrationControls
 *       state={narration.state}
 *       isLoading={narration.isLoading}
 *       onPlay={narration.play}
 *       onPause={narration.pause}
 *       onSkipForward={narration.skipForward}
 *       onSkipBackward={narration.skipBackward}
 *     />
 *   );
 * }
 * ```
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { trpc } from "@/lib/trpc/client";
import { ArticleNarrator, type NarrationState } from "@/lib/narration/ArticleNarrator";
import { useNarrationSettings } from "@/lib/narration/settings";
import { findVoiceByUri, waitForVoices } from "@/lib/narration/voices";
import {
  setupMediaSession,
  clearMediaSession,
  createMediaSessionStateHandler,
} from "@/lib/narration/media-session";
import { isNarrationSupported } from "@/lib/narration/feature-detection";
import { trackNarrationPlaybackStarted } from "@/lib/telemetry";
import { getPiperTTSProvider } from "@/lib/narration/piper-tts-provider";
import { isEnhancedVoice } from "@/lib/narration/enhanced-voices";
import { LRUCache } from "@/lib/narration/lru-cache";
import { htmlToClientNarration } from "@/lib/narration/client-paragraph-ids";
import { MIN_PREBUFFER_DURATION_SECONDS } from "@/lib/narration/audio-buffer-utils";

/**
 * Configuration for the useNarration hook.
 */
export interface UseNarrationConfig {
  /** The article ID (entry or saved article) */
  id: string;
  /** Type of article: 'entry' for feed entries, 'saved' for saved articles */
  type: "entry" | "saved";
  /** Title of the article (for Media Session) */
  title: string;
  /** Feed or site name (for Media Session) */
  feedTitle: string;
  /** Optional artwork URL for Media Session */
  artwork?: string;
  /**
   * Optional HTML content for client-side processing.
   * When provided and LLM normalization is disabled, narration will be
   * generated client-side without a server call.
   */
  content?: string | null;
}

/**
 * Return type for the useNarration hook.
 */
export interface UseNarrationReturn {
  /** Current narration state */
  state: NarrationState;
  /** Whether narration text is being generated */
  isLoading: boolean;
  /** Start or resume playback */
  play: () => void;
  /** Pause playback */
  pause: () => void;
  /** Skip to the next paragraph */
  skipForward: () => void;
  /** Skip to the previous paragraph */
  skipBackward: () => void;
  /** Stop playback and reset to beginning */
  stop: () => void;
  /** Whether narration is supported in this browser */
  isSupported: boolean;
  /** Processed HTML with data-para-id attributes (only for client-side narration) */
  processedHtml: string | null;
}

/**
 * Default narration state when no article is loaded.
 */
const DEFAULT_STATE: NarrationState = {
  status: "idle",
  currentParagraph: 0,
  totalParagraphs: 0,
  selectedVoice: null,
};

/**
 * Maximum number of audio buffers to cache.
 * Each AudioBuffer can be ~1-5MB depending on paragraph length,
 * so 50 paragraphs limits memory to roughly 50-250MB worst case.
 */
const AUDIO_CACHE_MAX_SIZE = 50;

/**
 * Splits narration text into paragraphs.
 */
function splitIntoParagraphs(text: string): string[] {
  return text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Hook for managing article narration.
 *
 * Handles:
 * - Generating narration text via the API
 * - Managing the ArticleNarrator instance (for browser voices)
 * - Managing Piper TTS playback (for enhanced voices)
 * - Integrating with Media Session API
 * - Using user's voice/rate/pitch preferences
 *
 * @param config - Configuration including article ID, type, and metadata
 * @returns Object with narration state and control functions
 */
export function useNarration(config: UseNarrationConfig): UseNarrationReturn {
  const { id, type, title, feedTitle, artwork, content } = config;

  // State
  const [state, setState] = useState<NarrationState>(DEFAULT_STATE);
  const [isLoading, setIsLoading] = useState(false);
  const [narrationText, setNarrationText] = useState<string | null>(null);
  const [isSupported] = useState(() => isNarrationSupported());
  const [processedHtml, setProcessedHtml] = useState<string | null>(null);

  // Refs
  const narratorRef = useRef<ArticleNarrator | null>(null);
  const mediaSessionUnsubscribeRef = useRef<(() => void) | null>(null);

  // Piper-specific refs for paragraph management
  const piperParagraphsRef = useRef<string[]>([]);
  const piperCurrentIndexRef = useRef(0);
  const piperIsPausedRef = useRef(false);

  // LRU audio cache for instant rewind/skip (paragraph index -> AudioBuffer)
  // Limited to AUDIO_CACHE_MAX_SIZE to prevent unbounded memory growth
  const audioCacheRef = useRef<LRUCache<number, AudioBuffer>>(new LRUCache(AUDIO_CACHE_MAX_SIZE));
  // Track which paragraphs are currently being pre-buffered to avoid duplicates
  const bufferingRef = useRef<Set<number>>(new Set());

  // Get user settings
  const [settings] = useNarrationSettings();

  // Determine if we should use Piper provider
  const usePiper =
    settings.provider === "piper" && settings.voiceId && isEnhancedVoice(settings.voiceId);

  // tRPC mutation for generating narration
  const generateMutation = trpc.narration.generate.useMutation();

  // Initialize narrator instance (for browser voices)
  useEffect(() => {
    if (!isSupported) return;

    narratorRef.current = new ArticleNarrator();

    // Subscribe to state changes (only used when not using Piper)
    const unsubscribe = narratorRef.current.onStateChange((newState) => {
      // Only update state from ArticleNarrator if we're using browser voices
      if (!usePiper) {
        setState(newState);
      }
    });

    return () => {
      unsubscribe();
      narratorRef.current?.stop();
      narratorRef.current = null;
    };
  }, [isSupported, usePiper]);

  // Set up Media Session when we have narration text (browser voices only for now)
  useEffect(() => {
    if (!isSupported || !narrationText || !narratorRef.current || usePiper) return;

    // Set up Media Session
    setupMediaSession({
      articleTitle: title,
      feedTitle: feedTitle,
      narrator: narratorRef.current,
      artwork,
    });

    // Subscribe to state changes for Media Session updates
    const stateHandler = createMediaSessionStateHandler();
    mediaSessionUnsubscribeRef.current = narratorRef.current.onStateChange(stateHandler);

    return () => {
      clearMediaSession();
      if (mediaSessionUnsubscribeRef.current) {
        mediaSessionUnsubscribeRef.current();
        mediaSessionUnsubscribeRef.current = null;
      }
    };
  }, [isSupported, narrationText, title, feedTitle, artwork, usePiper]);

  // Apply user settings when they change (browser voices only)
  useEffect(() => {
    if (!narratorRef.current || usePiper) return;

    narratorRef.current.setRate(settings.rate);
    narratorRef.current.setPitch(settings.pitch);
  }, [settings.rate, settings.pitch, usePiper]);

  // Get the voice from settings when it changes (browser voices only)
  useEffect(() => {
    if (!isSupported || !narratorRef.current || usePiper) return;

    async function updateVoice() {
      if (settings.voiceId) {
        // Wait for voices to be available, then find the selected one
        await waitForVoices();
        const voice = findVoiceByUri(settings.voiceId);
        if (voice) {
          narratorRef.current?.setVoice(voice);
        }
      }
    }

    updateVoice();
  }, [isSupported, settings.voiceId, usePiper]);

  /**
   * Calculates total buffered duration ahead of the current paragraph.
   */
  const getBufferedDurationAhead = useCallback(
    (paragraphs: string[], currentIndex: number): number => {
      let totalDuration = 0;
      for (let i = currentIndex + 1; i < paragraphs.length; i++) {
        const buffer = audioCacheRef.current.get(i);
        if (buffer) {
          totalDuration += buffer.duration;
        } else {
          // Stop counting if there's a gap in buffered paragraphs
          break;
        }
      }
      return totalDuration;
    },
    []
  );

  /**
   * Pre-buffers paragraphs ahead until we have at least MIN_PREBUFFER_DURATION_SECONDS
   * of audio buffered. This ensures smooth playback even with short sentences.
   */
  const preBufferAhead = useCallback(
    async (paragraphs: string[], currentIndex: number) => {
      if (!settings.voiceId) return;

      const piperProvider = getPiperTTSProvider();
      let bufferedDuration = getBufferedDurationAhead(paragraphs, currentIndex);
      let nextIndex = currentIndex + 1;

      // Keep buffering until we have enough duration or run out of paragraphs
      while (bufferedDuration < MIN_PREBUFFER_DURATION_SECONDS && nextIndex < paragraphs.length) {
        // Skip if already cached or being buffered
        if (audioCacheRef.current.has(nextIndex) || bufferingRef.current.has(nextIndex)) {
          const existingBuffer = audioCacheRef.current.get(nextIndex);
          if (existingBuffer) {
            bufferedDuration += existingBuffer.duration;
          }
          nextIndex++;
          continue;
        }

        bufferingRef.current.add(nextIndex);

        try {
          const buffer = await piperProvider.generateParagraphAudio(
            paragraphs[nextIndex],
            settings.voiceId,
            settings.sentenceGapSeconds
          );
          audioCacheRef.current.set(nextIndex, buffer);
          bufferedDuration += buffer.duration;
        } catch (error) {
          // Silently fail pre-buffering - we'll generate on-demand if needed
          console.debug("Pre-buffering failed for paragraph", nextIndex, error);
        } finally {
          bufferingRef.current.delete(nextIndex);
        }

        nextIndex++;
      }
    },
    [settings.voiceId, settings.sentenceGapSeconds, getBufferedDurationAhead]
  );

  /**
   * Speaks the current paragraph using Piper and auto-advances to the next.
   * Uses cached audio if available, otherwise generates and caches it.
   * Pre-buffers upcoming paragraphs to ensure at least 5 seconds of audio is ready.
   */
  const speakPiperParagraph = useCallback(
    async (paragraphs: string[], index: number) => {
      if (index >= paragraphs.length || !settings.voiceId) {
        // Done with all paragraphs
        setState((prev) => ({
          ...prev,
          status: "idle",
          currentParagraph: 0,
        }));
        piperCurrentIndexRef.current = 0;
        return;
      }

      const piperProvider = getPiperTTSProvider();
      const text = paragraphs[index];

      setState((prev) => ({
        ...prev,
        status: "playing",
        currentParagraph: index,
        totalParagraphs: paragraphs.length,
      }));

      try {
        // Check if we have cached audio for this paragraph
        let audioBuffer = audioCacheRef.current.get(index);

        if (!audioBuffer) {
          // Generate audio using sentence-level synthesis and cache it
          audioBuffer = await piperProvider.generateParagraphAudio(
            text,
            settings.voiceId,
            settings.sentenceGapSeconds
          );
          audioCacheRef.current.set(index, audioBuffer);
        }

        // Start pre-buffering upcoming paragraphs (at least 5 seconds ahead)
        preBufferAhead(paragraphs, index);

        // Play the audio
        piperProvider.playBuffer(audioBuffer, {
          voiceId: settings.voiceId,
          rate: settings.rate,
          onStart: () => {
            // Already updated state above
          },
          onEnd: () => {
            // Auto-advance to next paragraph if not paused
            if (!piperIsPausedRef.current) {
              piperCurrentIndexRef.current = index + 1;
              speakPiperParagraph(paragraphs, index + 1);
            }
          },
          onError: (error) => {
            console.error("Piper TTS error:", error);
            setState((prev) => ({ ...prev, status: "idle" }));
          },
        });
      } catch (error) {
        console.error("Piper TTS error:", error);
        setState((prev) => ({ ...prev, status: "idle" }));
      }
    },
    [settings.voiceId, settings.rate, settings.sentenceGapSeconds, preBufferAhead]
  );

  /**
   * Start or resume playback.
   * If narration hasn't been generated yet, generates it first.
   */
  const play = useCallback(async () => {
    if (!isSupported) return;

    // Handle Piper provider
    if (usePiper && settings.voiceId) {
      const piperProvider = getPiperTTSProvider();

      // If paused, resume
      if (state.status === "paused") {
        piperIsPausedRef.current = false;
        piperProvider.resume();
        setState((prev) => ({ ...prev, status: "playing" }));
        return;
      }

      // If already playing, do nothing
      if (state.status === "playing") return;

      // If we already have narration text loaded, just play
      if (narrationText && piperParagraphsRef.current.length > 0) {
        trackNarrationPlaybackStarted(settings.provider);
        piperIsPausedRef.current = false;
        await speakPiperParagraph(piperParagraphsRef.current, piperCurrentIndexRef.current);
        return;
      }

      // Need to generate narration
      setIsLoading(true);
      setState((prev) => ({ ...prev, status: "loading" }));

      try {
        let narration: string;
        let processedHtmlResult: string | null = null;

        // If LLM normalization is disabled and we have content, process client-side
        if (!settings.useLlmNormalization && content) {
          const clientResult = htmlToClientNarration(content);
          narration = clientResult.narrationText;
          processedHtmlResult = clientResult.processedHtml;
        } else {
          // Call server for LLM processing
          const result = await generateMutation.mutateAsync({
            id,
            type,
            useLlmNormalization: settings.useLlmNormalization,
          });
          narration = result.narration;
        }

        if (narration) {
          setNarrationText(narration);
          setProcessedHtml(processedHtmlResult);
          const paragraphs = splitIntoParagraphs(narration);
          piperParagraphsRef.current = paragraphs;
          piperCurrentIndexRef.current = 0;
          piperIsPausedRef.current = false;

          // Track playback start
          trackNarrationPlaybackStarted(settings.provider);

          // Start playback
          await speakPiperParagraph(paragraphs, 0);
        }
      } catch (error) {
        console.error("Failed to generate narration:", error);
        setState((prev) => ({ ...prev, status: "idle" }));
      } finally {
        setIsLoading(false);
      }
      return;
    }

    // Handle browser voices (existing logic)
    if (!narratorRef.current) return;

    const narrator = narratorRef.current;

    // If paused, just resume
    if (state.status === "paused") {
      narrator.resume();
      return;
    }

    // If already playing, do nothing
    if (state.status === "playing") return;

    // If we already have narration text loaded, just play
    if (narrationText && state.totalParagraphs > 0) {
      // Get the voice if we have a preference
      let voice: SpeechSynthesisVoice | undefined;
      if (settings.voiceId) {
        const foundVoice = findVoiceByUri(settings.voiceId);
        if (foundVoice) {
          voice = foundVoice;
        }
      }
      narrator.play(voice, settings.rate, settings.pitch);
      // Track playback start with the current provider
      trackNarrationPlaybackStarted(settings.provider);
      return;
    }

    // Need to generate narration
    setIsLoading(true);
    setState((prev) => ({ ...prev, status: "loading" }));

    try {
      let narration: string;
      let processedHtmlResult: string | null = null;

      // If LLM normalization is disabled and we have content, process client-side
      if (!settings.useLlmNormalization && content) {
        const clientResult = htmlToClientNarration(content);
        narration = clientResult.narrationText;
        processedHtmlResult = clientResult.processedHtml;
      } else {
        // Call server for LLM processing
        const result = await generateMutation.mutateAsync({
          id,
          type,
          useLlmNormalization: settings.useLlmNormalization,
        });
        narration = result.narration;
      }

      if (narration) {
        setNarrationText(narration);
        setProcessedHtml(processedHtmlResult);
        narrator.loadArticle(narration);

        // Wait for voices and get preferred voice
        await waitForVoices();
        let voice: SpeechSynthesisVoice | undefined;
        if (settings.voiceId) {
          const foundVoice = findVoiceByUri(settings.voiceId);
          if (foundVoice) {
            voice = foundVoice;
          }
        }

        // Start playback
        narrator.play(voice, settings.rate, settings.pitch);
        // Track playback start with the current provider
        trackNarrationPlaybackStarted(settings.provider);
      }
    } catch (error) {
      console.error("Failed to generate narration:", error);
      setState((prev) => ({ ...prev, status: "idle" }));
    } finally {
      setIsLoading(false);
    }
  }, [
    isSupported,
    usePiper,
    state.status,
    state.totalParagraphs,
    narrationText,
    settings.voiceId,
    settings.rate,
    settings.pitch,
    settings.provider,
    settings.useLlmNormalization,
    generateMutation,
    id,
    type,
    content,
    speakPiperParagraph,
  ]);

  /**
   * Pause playback.
   */
  const pause = useCallback(() => {
    if (!isSupported) return;

    if (usePiper) {
      const piperProvider = getPiperTTSProvider();
      piperIsPausedRef.current = true;
      piperProvider.pause();
      setState((prev) => ({ ...prev, status: "paused" }));
      return;
    }

    if (!narratorRef.current) return;
    narratorRef.current.pause();
  }, [isSupported, usePiper]);

  /**
   * Skip to the next paragraph.
   */
  const skipForward = useCallback(() => {
    if (!isSupported) return;

    if (usePiper) {
      const piperProvider = getPiperTTSProvider();
      piperProvider.stop();
      piperIsPausedRef.current = false;

      const paragraphs = piperParagraphsRef.current;
      const currentIndex = piperCurrentIndexRef.current;

      if (currentIndex < paragraphs.length - 1) {
        piperCurrentIndexRef.current = currentIndex + 1;
        speakPiperParagraph(paragraphs, currentIndex + 1);
      } else {
        // At the last paragraph, stop
        setState((prev) => ({ ...prev, status: "idle" }));
      }
      return;
    }

    if (!narratorRef.current) return;
    narratorRef.current.skipForward();
  }, [isSupported, usePiper, speakPiperParagraph]);

  /**
   * Skip to the previous paragraph.
   */
  const skipBackward = useCallback(() => {
    if (!isSupported) return;

    if (usePiper) {
      const piperProvider = getPiperTTSProvider();
      piperProvider.stop();
      piperIsPausedRef.current = false;

      const paragraphs = piperParagraphsRef.current;
      const currentIndex = piperCurrentIndexRef.current;

      const newIndex = Math.max(currentIndex - 1, 0);
      piperCurrentIndexRef.current = newIndex;
      speakPiperParagraph(paragraphs, newIndex);
      return;
    }

    if (!narratorRef.current) return;
    narratorRef.current.skipBackward();
  }, [isSupported, usePiper, speakPiperParagraph]);

  /**
   * Stop playback and reset to beginning.
   */
  const stop = useCallback(() => {
    if (!isSupported) return;

    if (usePiper) {
      const piperProvider = getPiperTTSProvider();
      piperProvider.stop();
      piperIsPausedRef.current = false;
      piperCurrentIndexRef.current = 0;
      setState((prev) => ({
        ...prev,
        status: "idle",
        currentParagraph: 0,
      }));
      return;
    }

    if (!narratorRef.current) return;
    narratorRef.current.stop();
  }, [isSupported, usePiper]);

  // Clear audio cache and processed HTML when article or voice changes
  useEffect(() => {
    // Clear the cache when article or voice changes
    audioCacheRef.current.clear();
    bufferingRef.current.clear();
    piperParagraphsRef.current = [];
    piperCurrentIndexRef.current = 0;
    // Clear processed HTML when article changes
    setProcessedHtml(null);
    setNarrationText(null);
  }, [id, settings.voiceId]);

  // Clean up on unmount
  useEffect(() => {
    // Capture refs for cleanup
    const audioCache = audioCacheRef.current;
    const buffering = bufferingRef.current;

    return () => {
      narratorRef.current?.stop();
      // Also stop Piper if it's playing
      const piperProvider = getPiperTTSProvider();
      piperProvider.stop();
      clearMediaSession();
      // Clear cache on unmount
      audioCache.clear();
      buffering.clear();
    };
  }, []);

  return {
    state,
    isLoading,
    play,
    pause,
    skipForward,
    skipBackward,
    stop,
    isSupported,
    processedHtml,
  };
}

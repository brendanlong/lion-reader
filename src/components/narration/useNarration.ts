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
}

/**
 * Paragraph mapping entry for highlighting support.
 * Maps a narration paragraph index to one or more original paragraph indices.
 */
export interface ParagraphMapEntry {
  /** Narration paragraph index */
  n: number;
  /** Original paragraph indices (can be multiple if LLM combined) */
  o: number[];
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
  /** Paragraph mapping for highlighting (narration index -> original indices) */
  paragraphMap: ParagraphMapEntry[] | null;
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
  const { id, type, title, feedTitle, artwork } = config;

  // State
  const [state, setState] = useState<NarrationState>(DEFAULT_STATE);
  const [isLoading, setIsLoading] = useState(false);
  const [narrationText, setNarrationText] = useState<string | null>(null);
  const [isSupported] = useState(() => isNarrationSupported());
  const [paragraphMap, setParagraphMap] = useState<ParagraphMapEntry[] | null>(null);

  // Refs
  const narratorRef = useRef<ArticleNarrator | null>(null);
  const mediaSessionUnsubscribeRef = useRef<(() => void) | null>(null);

  // Piper-specific refs for paragraph management
  const piperParagraphsRef = useRef<string[]>([]);
  const piperCurrentIndexRef = useRef(0);
  const piperIsPausedRef = useRef(false);

  // Audio cache for instant rewind/skip (Map of paragraph index -> AudioBuffer)
  const audioCacheRef = useRef<Map<number, AudioBuffer>>(new Map());
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
   * Pre-buffers a paragraph's audio in the background.
   */
  const preBufferParagraph = useCallback(
    async (paragraphs: string[], index: number) => {
      if (!settings.voiceId) return;
      if (index < 0 || index >= paragraphs.length) return;
      if (audioCacheRef.current.has(index)) return; // Already cached
      if (bufferingRef.current.has(index)) return; // Already buffering

      bufferingRef.current.add(index);

      try {
        const piperProvider = getPiperTTSProvider();
        const buffer = await piperProvider.generateAudio(paragraphs[index], settings.voiceId);
        audioCacheRef.current.set(index, buffer);
      } catch (error) {
        // Silently fail pre-buffering - we'll generate on-demand if needed
        console.debug("Pre-buffering failed for paragraph", index, error);
      } finally {
        bufferingRef.current.delete(index);
      }
    },
    [settings.voiceId]
  );

  /**
   * Speaks the current paragraph using Piper and auto-advances to the next.
   * Uses cached audio if available, otherwise generates and caches it.
   * Pre-buffers the next paragraph while current one is playing.
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
          // Generate audio and cache it
          audioBuffer = await piperProvider.generateAudio(text, settings.voiceId);
          audioCacheRef.current.set(index, audioBuffer);
        }

        // Start pre-buffering the next paragraph while this one plays
        if (index + 1 < paragraphs.length) {
          preBufferParagraph(paragraphs, index + 1);
        }

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
    [settings.voiceId, settings.rate, preBufferParagraph]
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
        const result = await generateMutation.mutateAsync({ id, type });

        if (result.narration) {
          setNarrationText(result.narration);
          setParagraphMap(result.paragraphMap ?? null);
          const paragraphs = splitIntoParagraphs(result.narration);
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
      const result = await generateMutation.mutateAsync({ id, type });

      if (result.narration) {
        setNarrationText(result.narration);
        setParagraphMap(result.paragraphMap ?? null);
        narrator.loadArticle(result.narration);

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
    generateMutation,
    id,
    type,
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

  // Clear audio cache and paragraph map when article or voice changes
  useEffect(() => {
    // Clear the cache when article or voice changes
    audioCacheRef.current.clear();
    bufferingRef.current.clear();
    piperParagraphsRef.current = [];
    piperCurrentIndexRef.current = 0;
    // Clear paragraph map when article changes, as it's tied to narration content
    setParagraphMap(null);
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
    paragraphMap,
  };
}

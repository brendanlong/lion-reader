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
 *   const narration = useNarration({ id: articleId, title: 'Article Title', feedTitle: 'Feed' });
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

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
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
import {
  htmlToClientNarration,
  type ParagraphMapEntry,
} from "@/lib/narration/client-paragraph-ids";
import {
  StreamingAudioPlayer,
  type PlaybackPosition,
  type PlaybackStatus,
} from "@/lib/narration/streaming-audio-player";
import {
  type UseNarrationConfig,
  type UseNarrationReturn,
  DEFAULT_NARRATION_STATE,
  splitIntoParagraphs,
  mapPlaybackStatus,
} from "./useNarrationTypes";

// Re-export types for consumers
export type { UseNarrationConfig, UseNarrationReturn };

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
 * @param config - Configuration including article ID and metadata
 * @returns Object with narration state and control functions
 */
export function useNarration(config: UseNarrationConfig): UseNarrationReturn {
  const { id, title, feedTitle, artwork, content } = config;

  // State
  const [state, setState] = useState<NarrationState>(DEFAULT_NARRATION_STATE);
  const [isLoading, setIsLoading] = useState(false);
  const [narrationText, setNarrationText] = useState<string | null>(null);
  // Defer browser support check until after hydration to avoid SSR mismatch
  // useSyncExternalStore ensures the check runs after hydration without cascading renders
  const isSupported = useSyncExternalStore(
    () => () => {}, // No subscription needed - browser capabilities don't change
    () => isNarrationSupported(), // Client snapshot
    () => false // Server snapshot - always false during SSR
  );
  const [processedHtml, setProcessedHtml] = useState<string | null>(null);

  // Refs
  const narratorRef = useRef<ArticleNarrator | null>(null);
  const mediaSessionUnsubscribeRef = useRef<(() => void) | null>(null);

  // Streaming audio player for Piper TTS (sentence-level buffering)
  const streamingPlayerRef = useRef<StreamingAudioPlayer | null>(null);
  // Track if we've already set up playback tracking for this session
  const hasTrackedPlaybackRef = useRef(false);
  // Paragraph mapping for translating narration indices to DOM element indices
  const paragraphMapRef = useRef<ParagraphMapEntry[]>([]);

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
        // Translate narration paragraph index to DOM element index using the mapping
        const mapping = paragraphMapRef.current[newState.currentParagraph];
        const domElementIndex = mapping ? mapping.o : newState.currentParagraph;

        setState({
          ...newState,
          currentParagraph: domElementIndex,
        });
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
   * Initialize or get the StreamingAudioPlayer for Piper TTS.
   */
  const getOrCreateStreamingPlayer = useCallback((): StreamingAudioPlayer => {
    if (!streamingPlayerRef.current) {
      const piperProvider = getPiperTTSProvider();

      streamingPlayerRef.current = new StreamingAudioPlayer(
        // generateAudio
        (text: string, voiceId: string) => piperProvider.generateAudio(text, voiceId),
        // playBuffer
        (buffer: AudioBuffer, options) => piperProvider.playBuffer(buffer, options),
        // stopPlayback
        () => piperProvider.stop(),
        // pausePlayback
        () => piperProvider.pause(),
        // resumePlayback
        () => piperProvider.resume(),
        // getAudioContext
        () => piperProvider.getAudioContext()
      );

      // Set up callbacks to update React state
      streamingPlayerRef.current.setCallbacks({
        onStatusChange: (status: PlaybackStatus) => {
          setState((prev) => ({
            ...prev,
            status: mapPlaybackStatus(status),
          }));
        },
        onPositionChange: (position: PlaybackPosition, totalParagraphs: number) => {
          // Translate narration paragraph index to DOM element index using the mapping
          const mapping = paragraphMapRef.current[position.paragraph];
          const domElementIndex = mapping ? mapping.o : position.paragraph;

          setState((prev) => ({
            ...prev,
            currentParagraph: domElementIndex,
            totalParagraphs,
          }));
        },
        onError: (error: Error) => {
          console.error("Streaming playback error:", error);
          setState((prev) => ({ ...prev, status: "idle" }));
        },
        onEnd: () => {
          setState((prev) => ({
            ...prev,
            status: "idle",
            currentParagraph: 0,
          }));
        },
      });
    }

    return streamingPlayerRef.current;
  }, []);

  /**
   * Start or resume playback.
   * If narration hasn't been generated yet, generates it first.
   */
  const play = useCallback(async () => {
    if (!isSupported) return;

    // Handle Piper provider with StreamingAudioPlayer
    if (usePiper && settings.voiceId) {
      const player = getOrCreateStreamingPlayer();

      // Update config in case settings changed
      player.setConfig({
        voiceId: settings.voiceId,
        rate: settings.rate,
        sentenceGapSeconds: settings.sentenceGapSeconds,
      });

      // If paused or already has paragraphs loaded, just play
      const playerStatus = player.getStatus();
      if (playerStatus === "paused" || playerStatus === "playing") {
        if (playerStatus === "paused") {
          await player.play();
        }
        return;
      }

      // If we already have narration text loaded, just play
      if (narrationText) {
        const paragraphs = splitIntoParagraphs(narrationText);
        player.load(paragraphs);

        // Track playback start (only once per session)
        if (!hasTrackedPlaybackRef.current) {
          trackNarrationPlaybackStarted(settings.provider);
          hasTrackedPlaybackRef.current = true;
        }

        await player.play();
        return;
      }

      // Need to generate narration text first
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
          // Store the paragraph map for index translation during highlighting
          paragraphMapRef.current = clientResult.paragraphMap;
        } else {
          // Call server for LLM processing
          const result = await generateMutation.mutateAsync({
            id,
            useLlmNormalization: settings.useLlmNormalization,
          });
          narration = result.narration;
          // Store the paragraph map from server for index translation during highlighting
          paragraphMapRef.current = result.paragraphMap;
        }

        if (narration) {
          setNarrationText(narration);
          setProcessedHtml(processedHtmlResult);
          const paragraphs = splitIntoParagraphs(narration);

          // Load paragraphs into streaming player
          player.load(paragraphs);

          // Track playback start
          if (!hasTrackedPlaybackRef.current) {
            trackNarrationPlaybackStarted(settings.provider);
            hasTrackedPlaybackRef.current = true;
          }

          // Start playback
          await player.play();
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
        // Store the paragraph map for index translation during highlighting
        paragraphMapRef.current = clientResult.paragraphMap;
      } else {
        // Call server for LLM processing
        const result = await generateMutation.mutateAsync({
          id,
          useLlmNormalization: settings.useLlmNormalization,
        });
        narration = result.narration;
        // Store the paragraph map from server for index translation during highlighting
        paragraphMapRef.current = result.paragraphMap;
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
    settings.sentenceGapSeconds,
    settings.provider,
    settings.useLlmNormalization,
    generateMutation,
    id,
    content,
    getOrCreateStreamingPlayer,
  ]);

  /**
   * Pause playback.
   */
  const pause = useCallback(() => {
    if (!isSupported) return;

    if (usePiper) {
      const player = streamingPlayerRef.current;
      if (player) {
        player.pause();
      }
      return;
    }

    if (!narratorRef.current) return;
    narratorRef.current.pause();
  }, [isSupported, usePiper]);

  /**
   * Skip to the next paragraph.
   */
  const skipForward = useCallback(async () => {
    if (!isSupported) return;

    if (usePiper) {
      const player = streamingPlayerRef.current;
      if (player) {
        await player.skipForward();
      }
      return;
    }

    if (!narratorRef.current) return;
    narratorRef.current.skipForward();
  }, [isSupported, usePiper]);

  /**
   * Skip to the previous paragraph.
   */
  const skipBackward = useCallback(async () => {
    if (!isSupported) return;

    if (usePiper) {
      const player = streamingPlayerRef.current;
      if (player) {
        await player.skipBackward();
      }
      return;
    }

    if (!narratorRef.current) return;
    narratorRef.current.skipBackward();
  }, [isSupported, usePiper]);

  /**
   * Stop playback and reset to beginning.
   */
  const stop = useCallback(() => {
    if (!isSupported) return;

    if (usePiper) {
      const player = streamingPlayerRef.current;
      if (player) {
        player.stop();
      }
      return;
    }

    if (!narratorRef.current) return;
    narratorRef.current.stop();
  }, [isSupported, usePiper]);

  // Clear audio cache and processed HTML when article or voice changes
  useEffect(() => {
    // Stop and clear the streaming player when article or voice changes
    if (streamingPlayerRef.current) {
      streamingPlayerRef.current.stop();
      streamingPlayerRef.current.clearCache();
    }
    // Reset playback tracking
    hasTrackedPlaybackRef.current = false;
    // Clear paragraph map when article changes
    paragraphMapRef.current = [];
    // Clear processed HTML when article changes
    setProcessedHtml(null);
    setNarrationText(null);
  }, [id, settings.voiceId]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      narratorRef.current?.stop();
      // Stop streaming player if it's playing
      if (streamingPlayerRef.current) {
        streamingPlayerRef.current.stop();
        streamingPlayerRef.current.clearCache();
      }
      clearMediaSession();
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

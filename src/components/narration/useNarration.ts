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
import {
  isNarrationSupported,
  isBackgroundAudioSupported,
  isMediaSessionSupported,
} from "@/lib/narration/feature-detection";
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
  BackgroundAudioPlayer,
  type BackgroundPlaybackStatus,
} from "@/lib/narration/background-audio-player";
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
 * Map BackgroundPlaybackStatus to NarrationState status.
 */
function mapBackgroundStatus(status: BackgroundPlaybackStatus): NarrationState["status"] {
  switch (status) {
    case "playing":
      return "playing";
    case "paused":
      return "paused";
    case "loading":
    case "buffering":
      return "loading";
    case "idle":
    default:
      return "idle";
  }
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
 * @param config - Configuration including article ID and metadata
 * @returns Object with narration state and control functions
 */
export function useNarration(config: UseNarrationConfig): UseNarrationReturn {
  const { id, title, feedTitle, artwork, content } = config;

  // State
  const [state, setState] = useState<NarrationState>(DEFAULT_NARRATION_STATE);
  const [isLoading, setIsLoading] = useState(false);
  const [narrationText, setNarrationText] = useState<string | null>(null);
  const [isSupported] = useState(() => isNarrationSupported());
  const [processedHtml, setProcessedHtml] = useState<string | null>(null);

  // Refs
  const narratorRef = useRef<ArticleNarrator | null>(null);
  const mediaSessionUnsubscribeRef = useRef<(() => void) | null>(null);

  // Streaming audio player for Piper TTS (sentence-level buffering)
  const streamingPlayerRef = useRef<StreamingAudioPlayer | null>(null);
  // Background audio player for mobile background playback
  const backgroundPlayerRef = useRef<BackgroundAudioPlayer | null>(null);
  // Track if we've already set up playback tracking for this session
  const hasTrackedPlaybackRef = useRef(false);
  // Paragraph mapping for translating narration indices to DOM element indices
  const paragraphMapRef = useRef<ParagraphMapEntry[]>([]);

  // Get user settings
  const [settings] = useNarrationSettings();

  // Determine if we should use Piper provider
  const usePiper =
    settings.provider === "piper" && settings.voiceId && isEnhancedVoice(settings.voiceId);

  // Determine if we should use background-compatible player (HTMLAudioElement + WebCodecs)
  // This enables background playback on mobile devices with media notification controls
  const useBackgroundPlayer = usePiper && isBackgroundAudioSupported();

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
   * Initialize or get the BackgroundAudioPlayer for mobile background playback.
   */
  const getOrCreateBackgroundPlayer = useCallback((): BackgroundAudioPlayer => {
    if (!backgroundPlayerRef.current) {
      const piperProvider = getPiperTTSProvider();

      backgroundPlayerRef.current = new BackgroundAudioPlayer((text: string, voiceId: string) =>
        piperProvider.generateAudio(text, voiceId)
      );

      // Set up callbacks to update React state
      backgroundPlayerRef.current.setCallbacks({
        onStatusChange: (status: BackgroundPlaybackStatus) => {
          setState((prev) => ({
            ...prev,
            status: mapBackgroundStatus(status),
          }));
        },
        onParagraphChange: (paragraphIndex: number, totalParagraphs: number) => {
          // Translate narration paragraph index to DOM element index using the mapping
          const mapping = paragraphMapRef.current[paragraphIndex];
          const domElementIndex = mapping ? mapping.o : paragraphIndex;

          setState((prev) => ({
            ...prev,
            currentParagraph: domElementIndex,
            totalParagraphs,
          }));
        },
        onError: (error: Error) => {
          console.error("Background playback error:", error);
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

    return backgroundPlayerRef.current;
  }, []);

  /**
   * Set up Media Session for background audio player.
   */
  const setupBackgroundMediaSession = useCallback(() => {
    if (!isMediaSessionSupported() || !backgroundPlayerRef.current) {
      return;
    }

    const player = backgroundPlayerRef.current;

    // Set metadata
    const artworkArray: MediaImage[] = artwork
      ? [
          { src: artwork, sizes: "512x512", type: "image/png" },
          { src: artwork, sizes: "256x256", type: "image/png" },
        ]
      : [];

    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist: feedTitle,
      album: "Lion Reader",
      artwork: artworkArray,
    });

    // Register action handlers
    navigator.mediaSession.setActionHandler("play", () => {
      player.play();
    });

    navigator.mediaSession.setActionHandler("pause", () => {
      player.pause();
    });

    navigator.mediaSession.setActionHandler("stop", () => {
      player.stop();
    });

    navigator.mediaSession.setActionHandler("previoustrack", () => {
      player.skipBackward();
    });

    navigator.mediaSession.setActionHandler("nexttrack", () => {
      player.skipForward();
    });
  }, [title, feedTitle, artwork]);

  /**
   * Start or resume playback.
   * If narration hasn't been generated yet, generates it first.
   */
  const play = useCallback(async () => {
    if (!isSupported) return;

    // Handle Piper provider with BackgroundAudioPlayer (for mobile background playback)
    if (useBackgroundPlayer && settings.voiceId) {
      const player = getOrCreateBackgroundPlayer();

      // Update config in case settings changed
      player.setConfig({
        voiceId: settings.voiceId,
        rate: settings.rate,
        sentenceGapSeconds: settings.sentenceGapSeconds,
      });

      // If paused or already playing, handle accordingly
      const playerStatus = player.getStatus();
      if (playerStatus === "paused") {
        await player.play();
        return;
      }
      if (playerStatus === "playing") {
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

        setupBackgroundMediaSession();
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

          // Load paragraphs into background player
          player.load(paragraphs);

          // Track playback start
          if (!hasTrackedPlaybackRef.current) {
            trackNarrationPlaybackStarted(settings.provider);
            hasTrackedPlaybackRef.current = true;
          }

          // Set up Media Session and start playback
          setupBackgroundMediaSession();
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

    // Handle Piper provider with StreamingAudioPlayer (for browsers without WebCodecs)
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
    useBackgroundPlayer,
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
    getOrCreateBackgroundPlayer,
    getOrCreateStreamingPlayer,
    setupBackgroundMediaSession,
  ]);

  /**
   * Pause playback.
   */
  const pause = useCallback(() => {
    if (!isSupported) return;

    if (useBackgroundPlayer) {
      backgroundPlayerRef.current?.pause();
      return;
    }

    if (usePiper) {
      streamingPlayerRef.current?.pause();
      return;
    }

    narratorRef.current?.pause();
  }, [isSupported, useBackgroundPlayer, usePiper]);

  /**
   * Skip to the next paragraph.
   */
  const skipForward = useCallback(async () => {
    if (!isSupported) return;

    if (useBackgroundPlayer) {
      await backgroundPlayerRef.current?.skipForward();
      return;
    }

    if (usePiper) {
      await streamingPlayerRef.current?.skipForward();
      return;
    }

    narratorRef.current?.skipForward();
  }, [isSupported, useBackgroundPlayer, usePiper]);

  /**
   * Skip to the previous paragraph.
   */
  const skipBackward = useCallback(async () => {
    if (!isSupported) return;

    if (useBackgroundPlayer) {
      await backgroundPlayerRef.current?.skipBackward();
      return;
    }

    if (usePiper) {
      await streamingPlayerRef.current?.skipBackward();
      return;
    }

    narratorRef.current?.skipBackward();
  }, [isSupported, useBackgroundPlayer, usePiper]);

  /**
   * Stop playback and reset to beginning.
   */
  const stop = useCallback(() => {
    if (!isSupported) return;

    if (useBackgroundPlayer) {
      backgroundPlayerRef.current?.stop();
      return;
    }

    if (usePiper) {
      streamingPlayerRef.current?.stop();
      return;
    }

    narratorRef.current?.stop();
  }, [isSupported, useBackgroundPlayer, usePiper]);

  // Clear audio cache and processed HTML when article or voice changes
  useEffect(() => {
    // Stop and clear players when article or voice changes
    if (streamingPlayerRef.current) {
      streamingPlayerRef.current.stop();
      streamingPlayerRef.current.clearCache();
    }
    if (backgroundPlayerRef.current) {
      backgroundPlayerRef.current.stop();
      backgroundPlayerRef.current.clearCache();
    }
    // Reset playback tracking
    hasTrackedPlaybackRef.current = false;
    // Clear paragraph map when article changes
    paragraphMapRef.current = [];
    // Clear processed HTML when article changes
    setProcessedHtml(null);
    setNarrationText(null);
  }, [id, settings.voiceId]);

  // Update Media Session playback state when status changes (for background player)
  useEffect(() => {
    if (!useBackgroundPlayer || !isMediaSessionSupported()) return;

    switch (state.status) {
      case "playing":
        navigator.mediaSession.playbackState = "playing";
        break;
      case "paused":
        navigator.mediaSession.playbackState = "paused";
        break;
      default:
        navigator.mediaSession.playbackState = "none";
    }
  }, [state.status, useBackgroundPlayer]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      narratorRef.current?.stop();
      // Stop streaming player if it's playing
      if (streamingPlayerRef.current) {
        streamingPlayerRef.current.stop();
        streamingPlayerRef.current.clearCache();
      }
      // Stop background player if it's playing
      if (backgroundPlayerRef.current) {
        backgroundPlayerRef.current.stop();
        backgroundPlayerRef.current.clearCache();
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

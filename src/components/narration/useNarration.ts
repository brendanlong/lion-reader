/**
 * useNarration Hook
 *
 * Manages article narration state using the Web Speech API (browser voices),
 * Piper TTS (enhanced voices), or server-synthesized cloud voices. Handles
 * narration generation, playback controls, and Media Session integration.
 *
 * The owning component holds the hook (it also needs `state.currentParagraph`
 * for highlighting) and hands the whole thing to the controls:
 *
 * ```tsx
 * function ArticleView({ articleId }: { articleId: string }) {
 *   const narration = useNarration({ id: articleId, title: 'Article Title', feedTitle: 'Feed' });
 *
 *   return <NarrationControls narration={narration} />;
 * }
 * ```
 */

"use client";

import { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { ArticleNarrator } from "@/lib/narration/ArticleNarrator";
import { useNarrationSettings } from "@/lib/narration/settings";
import { findVoiceByUri, waitForVoices } from "@/lib/narration/voices";
import { isNarrationSupported } from "@/lib/narration/feature-detection";
import {
  primeMediaSessionAudio,
  releasePrimedMediaSessionAudio,
} from "@/lib/narration/media-session";
import { useMediaSession } from "./useMediaSession";
import { trackNarrationPlaybackStarted } from "@/lib/telemetry";
import type {
  MediaSourcePlayer,
  PlaybackPosition,
  PlaybackStatus,
  PlayerCallbacks,
} from "@/lib/narration/media-source-player";
import { createCloudSpeechPlayer } from "@/lib/narration/cloud-speech";
import { createPiperSpeechPlayer } from "@/lib/narration/piper-speech";
import { isEnhancedVoice } from "@/lib/narration/enhanced-voices";
import {
  htmlToClientNarration,
  type ParagraphMapEntry,
} from "@/lib/narration/client-paragraph-ids";
import { narrationParagraphForElement } from "@/lib/narration/paragraph-map";
import {
  type UseNarrationConfig,
  type UseNarrationReturn,
  type UseNarrationState,
  DEFAULT_NARRATION_STATE,
  splitIntoParagraphs,
  mapPlaybackStatus,
} from "./useNarrationTypes";

function cancelPendingPlay(playRequest: { current: number }): void {
  playRequest.current++;
}

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
  const { id, title, feedTitle, artwork, content, showFullContent, showOriginal } = config;

  // State
  const [state, setState] = useState<UseNarrationState>(DEFAULT_NARRATION_STATE);
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

  // Piper and cloud voices each stream through their own Media Source player.
  const piperPlayerRef = useRef<MediaSourcePlayer | null>(null);
  const cloudPlayerRef = useRef<MediaSourcePlayer | null>(null);
  // Bumped by pause/stop/article changes, so a play() still generating
  // narration when the user moves on doesn't store or start it (see play()).
  const playRequestRef = useRef(0);
  // Counts narration loads, so only the latest one clears the loading state.
  const loadRequestRef = useRef(0);
  // Track if we've already set up playback tracking for this session
  const hasTrackedPlaybackRef = useRef(false);
  // Paragraph mapping for translating narration indices to DOM element indices
  const paragraphMapRef = useRef<ParagraphMapEntry[]>([]);

  // Get user settings
  const [settings] = useNarrationSettings();

  // Determine if we should use Piper provider
  const usePiper =
    settings.provider === "piper" && settings.voiceId && isEnhancedVoice(settings.voiceId);
  const useCloud = settings.provider === "cloud";
  // Piper and cloud voices drive their own player; browser voices use ArticleNarrator.
  const usesBufferedPlayer = usePiper || useCloud;

  // tRPC mutation for generating narration
  const generateMutation = trpc.narration.generate.useMutation();

  // The players outlive renders, so they read the current voice settings here.
  const voiceRef = useRef({
    model: settings.cloudModelId,
    voice: settings.voiceId,
    sentenceGapSeconds: settings.sentenceGapSeconds,
    cloudPauseSeconds: settings.cloudPauseSeconds,
  });
  useEffect(() => {
    voiceRef.current = {
      model: settings.cloudModelId,
      voice: settings.voiceId,
      sentenceGapSeconds: settings.sentenceGapSeconds,
      cloudPauseSeconds: settings.cloudPauseSeconds,
    };
  }, [
    settings.cloudModelId,
    settings.voiceId,
    settings.sentenceGapSeconds,
    settings.cloudPauseSeconds,
  ]);

  // Initialize narrator instance (for browser voices)
  useEffect(() => {
    if (!isSupported) return;

    narratorRef.current = new ArticleNarrator();

    // Subscribe to state changes (only used for browser voices)
    const unsubscribe = narratorRef.current.onStateChange((newState) => {
      if (!usesBufferedPlayer) {
        // Translate narration paragraph index to DOM element index using the mapping
        const mapping = paragraphMapRef.current[newState.currentParagraph];
        const domElementIndex = mapping ? mapping.o : newState.currentParagraph;

        setState({
          ...newState,
          currentParagraph: domElementIndex,
          currentNarrationParagraph: newState.currentParagraph,
        });
      }
    });

    return () => {
      unsubscribe();
      narratorRef.current?.stop();
      narratorRef.current = null;
    };
  }, [isSupported, usesBufferedPlayer]);

  // Apply user settings when they change
  useEffect(() => {
    piperPlayerRef.current?.setRate(settings.rate);
    cloudPlayerRef.current?.setRate(settings.rate);
    if (!narratorRef.current || usesBufferedPlayer) return;

    narratorRef.current.setRate(settings.rate);
    narratorRef.current.setPitch(settings.pitch);
  }, [settings.rate, settings.pitch, usesBufferedPlayer]);

  // Get the voice from settings when it changes (browser voices only)
  useEffect(() => {
    if (!isSupported || !narratorRef.current || usesBufferedPlayer) return;

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
  }, [isSupported, settings.voiceId, usesBufferedPlayer]);

  // State updates from the Piper and cloud players (same callback shape).
  const bufferedPlayerCallbacks = useMemo(
    (): PlayerCallbacks => ({
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
          currentNarrationParagraph: position.paragraph,
          totalParagraphs,
        }));
      },
      onError: (error: Error) => {
        console.error("Streaming playback error:", error);
        toast.error("Narration stopped", { description: error.message });
        setState((prev) => ({ ...prev, status: "idle" }));
      },
      onEnd: () => {
        setState((prev) => ({
          ...prev,
          status: "idle",
          currentParagraph: 0,
          currentNarrationParagraph: 0,
        }));
      },
    }),
    []
  );

  const getOrCreatePiperPlayer = useCallback((): MediaSourcePlayer => {
    if (!piperPlayerRef.current) {
      piperPlayerRef.current = createPiperSpeechPlayer(() => ({
        voice: voiceRef.current.voice,
        sentenceGapSeconds: voiceRef.current.sentenceGapSeconds,
      }));
      piperPlayerRef.current.setCallbacks(bufferedPlayerCallbacks);
    }
    return piperPlayerRef.current;
  }, [bufferedPlayerCallbacks]);

  const getOrCreateCloudPlayer = useCallback((): MediaSourcePlayer => {
    if (!cloudPlayerRef.current) {
      cloudPlayerRef.current = createCloudSpeechPlayer(() => ({
        model: voiceRef.current.model,
        voice: voiceRef.current.voice,
        pauseSeconds: voiceRef.current.cloudPauseSeconds,
      }));
      cloudPlayerRef.current.setCallbacks(bufferedPlayerCallbacks);
    }
    return cloudPlayerRef.current;
  }, [bufferedPlayerCallbacks]);

  /**
   * Start or resume playback.
   * If narration hasn't been generated yet, generates it first.
   */
  const play = useCallback(async () => {
    if (!isSupported) return;

    // pause/stop, and the article/voice/variant reset (including unmount), bump
    // this token. Every path re-checks it after each await, so narration that
    // finishes generating after the user moved on is neither stored (it may be
    // for a variant no longer on screen) nor played — playback would outlive
    // this entry's controls, and cloud playback is paid.
    const request = playRequestRef.current;
    const isStale = () => playRequestRef.current !== request;

    // Start the audio element within this user gesture, before any async
    // narration generation, so the browser grants it while the gesture's
    // autoplay activation is still valid (issue #410): Piper and cloud voices
    // prime their own player's element, browser voices the media session's
    // silent audio. It's released below if generation fails.
    const player = usePiper ? getOrCreatePiperPlayer() : useCloud ? getOrCreateCloudPlayer() : null;
    // Both primed elements are shared across requests, so each release only
    // takes effect if no newer play() has primed since.
    let playerLease: number | null = null;
    let mediaSessionGeneration: number | null = null;
    if (player) {
      if (player.getStatus() === "idle") playerLease = player.prime();
    } else {
      mediaSessionGeneration = primeMediaSessionAudio();
    }
    const releasePrimedAudio = () => {
      if (player) {
        if (playerLease !== null) player.releasePrime(playerLease);
      } else if (mediaSessionGeneration !== null) {
        releasePrimedMediaSessionAudio(mediaSessionGeneration);
      }
    };

    // Generates narration text (client-side, or on the server for LLM
    // normalization), stores it with its paragraph map, then hands it to `start`.
    const loadNarration = async (start: (narration: string) => Promise<void>) => {
      // Only the latest load owns the loading/idle state, so an abandoned one
      // finishing late can't flip a newer one's spinner off.
      const load = ++loadRequestRef.current;
      const isLatestLoad = () => loadRequestRef.current === load;
      setIsLoading(true);
      setState((prev) => ({ ...prev, status: "loading" }));

      try {
        let narration: string;
        let paragraphMap: ParagraphMapEntry[];
        let processedHtmlResult: string | null = null;

        if (!settings.useLlmNormalization && content) {
          const clientResult = htmlToClientNarration(content);
          narration = clientResult.narrationText;
          processedHtmlResult = clientResult.processedHtml;
          paragraphMap = clientResult.paragraphMap;
        } else {
          const result = await generateMutation.mutateAsync({
            id,
            useLlmNormalization: settings.useLlmNormalization,
            showFullContent: showFullContent ?? false,
            showOriginal: showOriginal ?? false,
          });
          narration = result.narration;
          paragraphMap = result.paragraphMap;
        }

        if (isStale()) {
          releasePrimedAudio();
          if (isLatestLoad()) setState((prev) => ({ ...prev, status: "idle" }));
          return;
        }

        paragraphMapRef.current = paragraphMap;
        if (narration) {
          setNarrationText(narration);
          setProcessedHtml(processedHtmlResult);
          await start(narration);
        } else {
          // Nothing to narrate — release the primed media-session audio.
          releasePrimedAudio();
        }
      } catch (error) {
        console.error("Failed to generate narration:", error);
        if (isLatestLoad()) setState((prev) => ({ ...prev, status: "idle" }));
        // Release the media-session audio primed within the play() gesture.
        releasePrimedAudio();
      } finally {
        if (isLatestLoad()) setIsLoading(false);
      }
    };

    if (player) {
      player.setRate(settings.rate);
      const playerStatus = player.getStatus();
      if (playerStatus === "paused") await player.play();
      if (playerStatus !== "idle") return;

      const start = async (narration: string) => {
        player.load(splitIntoParagraphs(narration));
        if (!hasTrackedPlaybackRef.current) {
          trackNarrationPlaybackStarted(settings.provider);
          hasTrackedPlaybackRef.current = true;
        }
        await player.play();
      };
      if (narrationText) await start(narrationText);
      else await loadNarration(start);
      return;
    }

    const narrator = narratorRef.current;
    if (!narrator) return;

    if (state.status === "paused") {
      narrator.resume();
      return;
    }
    if (state.status === "playing") return;

    const startBrowser = () => {
      const voice = settings.voiceId ? findVoiceByUri(settings.voiceId) : null;
      narrator.play(voice ?? undefined, settings.rate, settings.pitch);
      trackNarrationPlaybackStarted(settings.provider);
    };
    if (narrationText && state.totalParagraphs > 0) {
      startBrowser();
      return;
    }
    await loadNarration(async (narration) => {
      narrator.loadArticle(narration);
      await waitForVoices();
      if (isStale()) {
        releasePrimedAudio();
        return;
      }
      startBrowser();
    });
  }, [
    isSupported,
    usePiper,
    useCloud,
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
    content,
    showFullContent,
    showOriginal,
    getOrCreatePiperPlayer,
    getOrCreateCloudPlayer,
  ]);

  // The active Piper or cloud player, if either is in use.
  const bufferedPlayer = useCallback(
    () => (usePiper ? piperPlayerRef.current : useCloud ? cloudPlayerRef.current : null),
    [usePiper, useCloud]
  );

  const pause = useCallback(() => {
    if (!isSupported) return;
    cancelPendingPlay(playRequestRef);
    const player = bufferedPlayer();
    if (player) player.pause();
    else if (!usesBufferedPlayer) narratorRef.current?.pause();
  }, [isSupported, bufferedPlayer, usesBufferedPlayer]);

  const skipForward = useCallback(async () => {
    if (!isSupported) return;
    const player = bufferedPlayer();
    if (player) await player.skipForward();
    else if (!usesBufferedPlayer) narratorRef.current?.skipForward();
  }, [isSupported, bufferedPlayer, usesBufferedPlayer]);

  const skipBackward = useCallback(async () => {
    if (!isSupported) return;
    const player = bufferedPlayer();
    if (player) await player.skipBackward();
    else if (!usesBufferedPlayer) narratorRef.current?.skipBackward();
  }, [isSupported, bufferedPlayer, usesBufferedPlayer]);

  const playFromElement = useCallback(
    async (elementIndex: number) => {
      if (!isSupported) return;

      // No map means indices were never translated (see the state callbacks
      // above), so the element index already is the narration index.
      const paragraphIndex =
        paragraphMapRef.current.length === 0
          ? elementIndex
          : narrationParagraphForElement(paragraphMapRef.current, elementIndex);
      if (paragraphIndex === null) return;

      const player = bufferedPlayer();
      if (player) {
        await player.skipTo(paragraphIndex);
        return;
      }

      if (!usesBufferedPlayer) narratorRef.current?.skipTo(paragraphIndex);
    },
    [isSupported, bufferedPlayer, usesBufferedPlayer]
  );

  /**
   * Stop playback and reset to beginning.
   */
  const stop = useCallback(() => {
    if (!isSupported) return;
    cancelPendingPlay(playRequestRef);
    const player = bufferedPlayer();
    if (player) player.stop();
    else if (!usesBufferedPlayer) narratorRef.current?.stop();
  }, [isSupported, bufferedPlayer, usesBufferedPlayer]);

  // Reset narration state when the article, voice, or displayed content variant
  // changes (render-time pattern avoids cascading renders from calling setState
  // inside an effect). The variant is part of the key because narration text and
  // its paragraph map are variant-specific: replaying a cached "cleaned"
  // narration while the DOM now shows "full"/"original" would highlight the
  // wrong elements. Resetting forces the next play to re-narrate what's on screen.
  const narrationResetKey = `${id}:${settings.provider}:${settings.cloudModelId}:${settings.voiceId}:${showFullContent ?? false}:${showOriginal ?? false}`;
  const [prevNarrationResetKey, setPrevNarrationResetKey] = useState(narrationResetKey);
  if (narrationResetKey !== prevNarrationResetKey) {
    setPrevNarrationResetKey(narrationResetKey);
    setProcessedHtml(null);
    setNarrationText(null);
    // A load still in flight is abandoned (the effect cleanup below cancels
    // it), so end its spinner now rather than when the stale request returns.
    setIsLoading(false);
    setState((prev) => (prev.status === "loading" ? { ...prev, status: "idle" } : prev));
  }

  // Reset per-article refs, and stop/clear playback when the article, voice, or
  // displayed content variant changes (or on unmount).
  useEffect(() => {
    hasTrackedPlaybackRef.current = false;
    // The paragraph map is specific to the previous article/variant
    paragraphMapRef.current = [];
    return () => {
      // Stop the Web Speech utterance too, not just the media players: toggling
      // the content variant does not remount this hook (EntryContent is keyed only
      // by the entry id), so without this the browser voice keeps reading the old
      // variant while the paragraph map is cleared out from under it.
      narratorRef.current?.stop();
      piperPlayerRef.current?.stop();
      piperPlayerRef.current?.clearCache();
      cancelPendingPlay(playRequestRef);
      cloudPlayerRef.current?.stop();
      cloudPlayerRef.current?.clearCache();
    };
  }, [
    id,
    settings.provider,
    settings.cloudModelId,
    settings.voiceId,
    showFullContent,
    showOriginal,
  ]);

  // Expose OS-level media controls (lock screen, notification, Bluetooth/media
  // keys) while narration is active. Works for every provider by driving the
  // provider-agnostic play/pause/skip callbacks above. A session
  // exists once narration text has been generated for this article.
  useMediaSession({
    active: isSupported && narrationText !== null,
    title,
    feedTitle,
    artwork,
    status: state.status,
    ownsMediaElement: usesBufferedPlayer,
    controls: {
      play,
      pause,
      stop,
      previousTrack: skipBackward,
      nextTrack: skipForward,
    },
  });

  return {
    state,
    isLoading,
    play,
    pause,
    skipForward,
    skipBackward,
    playFromElement,
    stop,
    isSupported,
    processedHtml,
  };
}

/**
 * useEnhancedVoices Hook
 *
 * Manages enhanced voice state including download status,
 * downloading, and deletion of Piper TTS voices.
 *
 * @module components/narration/useEnhancedVoices
 */

"use client";

import { useState, useEffect, useCallback, useReducer, useRef, useMemo } from "react";
import { ENHANCED_VOICES, type EnhancedVoice } from "@/lib/narration/enhanced-voices";
import { getPiperTTSProvider } from "@/lib/narration/piper-tts-provider";
import { VoiceCache, STORAGE_LIMIT_BYTES } from "@/lib/narration/voice-cache";
import { getVoiceErrorInfo, type VoiceErrorInfo } from "@/lib/narration/errors";
import {
  trackEnhancedVoiceDownloadCompleted,
  trackEnhancedVoiceDownloadFailed,
  classifyDownloadError,
} from "@/lib/telemetry";
import { PREVIEW_TEXT } from "@/lib/narration/constants";

/**
 * State machine for voice manager operations (preview, error).
 *
 * Download state is tracked per-voice in the voiceStates map since multiple
 * voices can be in different download states simultaneously.
 */
type OperationState =
  | { status: "idle" }
  | { status: "previewing"; voiceId: string }
  | { status: "error"; error: string; errorInfo: VoiceErrorInfo; failedVoiceId: string | null }
  | {
      status: "previewing_error";
      voiceId: string;
      error: string;
      errorInfo: VoiceErrorInfo;
      failedVoiceId: string | null;
    };

type OperationAction =
  | { type: "START_PREVIEW"; voiceId: string }
  | { type: "STOP_PREVIEW" }
  | { type: "SET_ERROR"; error: string; errorInfo: VoiceErrorInfo; failedVoiceId: string | null }
  | { type: "CLEAR_ERROR" };

function operationReducer(state: OperationState, action: OperationAction): OperationState {
  switch (action.type) {
    case "START_PREVIEW":
      // Starting a preview clears errors
      return { status: "previewing", voiceId: action.voiceId };
    case "STOP_PREVIEW":
      // Stopping preview: preserve error if we're in previewing_error state
      if (state.status === "previewing_error") {
        return {
          status: "error",
          error: state.error,
          errorInfo: state.errorInfo,
          failedVoiceId: state.failedVoiceId,
        };
      }
      return { status: "idle" };
    case "SET_ERROR":
      // If previewing, keep previewing but record the error
      if (state.status === "previewing" || state.status === "previewing_error") {
        return {
          status: "previewing_error",
          voiceId: state.voiceId,
          error: action.error,
          errorInfo: action.errorInfo,
          failedVoiceId: action.failedVoiceId,
        };
      }
      return {
        status: "error",
        error: action.error,
        errorInfo: action.errorInfo,
        failedVoiceId: action.failedVoiceId,
      };
    case "CLEAR_ERROR":
      if (state.status === "previewing_error") {
        return { status: "previewing", voiceId: state.voiceId };
      }
      if (state.status === "error") {
        return { status: "idle" };
      }
      return state;
  }
}

/**
 * Download status for a voice.
 */
export type VoiceDownloadStatus = "not-downloaded" | "downloading" | "downloaded";

/**
 * State for a single enhanced voice.
 */
export interface EnhancedVoiceState {
  voice: EnhancedVoice;
  status: VoiceDownloadStatus;
  progress: number;
  /**
   * Error information if the download failed.
   */
  errorInfo?: VoiceErrorInfo;
}

/**
 * Return type for the useEnhancedVoices hook.
 */
export interface UseEnhancedVoicesReturn {
  /**
   * List of voices with their current state.
   */
  voices: EnhancedVoiceState[];

  /**
   * Whether the voice list is loading.
   */
  isLoading: boolean;

  /**
   * Download a voice by ID.
   */
  downloadVoice: (voiceId: string) => Promise<void>;

  /**
   * Remove a downloaded voice by ID.
   */
  removeVoice: (voiceId: string) => Promise<void>;

  /**
   * Preview a voice by speaking sample text.
   */
  previewVoice: (voiceId: string) => Promise<void>;

  /**
   * Stop the current preview.
   */
  stopPreview: () => void;

  /**
   * Whether a preview is currently playing.
   */
  isPreviewing: boolean;

  /**
   * The ID of the voice currently being previewed.
   */
  previewingVoiceId: string | null;

  /**
   * Refresh the voice status from storage.
   */
  refreshStatus: () => Promise<void>;

  /**
   * Error message if an operation failed.
   */
  error: string | null;

  /**
   * Full error information for the last failed operation.
   */
  lastErrorInfo: VoiceErrorInfo | null;

  /**
   * The voice ID that last failed to download (for retry).
   */
  failedVoiceId: string | null;

  /**
   * Clear the current error.
   */
  clearError: () => void;

  /**
   * Retry the last failed download.
   */
  retryDownload: () => Promise<void>;

  /**
   * Clear the error for a specific voice and retry.
   */
  retryVoiceDownload: (voiceId: string) => Promise<void>;

  /**
   * Total storage used by cached voices in bytes.
   */
  storageUsed: number;

  /**
   * Number of downloaded voices.
   */
  downloadedCount: number;

  /**
   * Whether the storage limit (200 MB) has been exceeded.
   */
  isStorageLimitExceeded: boolean;

  /**
   * Delete all cached voices.
   */
  deleteAllVoices: () => Promise<void>;
}

/**
 * Hook for managing enhanced voices.
 *
 * Provides state and operations for downloading, removing, and previewing
 * Piper TTS voices.
 *
 * @returns Object with voice states and operation handlers.
 *
 * @example
 * ```tsx
 * function VoiceList() {
 *   const { voices, downloadVoice, removeVoice, previewVoice, isPreviewing } = useEnhancedVoices();
 *
 *   return (
 *     <ul>
 *       {voices.map(({ voice, status }) => (
 *         <li key={voice.id}>
 *           {voice.displayName}
 *           {status === 'downloaded' && (
 *             <button onClick={() => previewVoice(voice.id)}>Preview</button>
 *           )}
 *         </li>
 *       ))}
 *     </ul>
 *   );
 * }
 * ```
 */
export function useEnhancedVoices(): UseEnhancedVoicesReturn {
  const [voiceStates, setVoiceStates] = useState<
    Map<string, { status: VoiceDownloadStatus; progress: number; errorInfo?: VoiceErrorInfo }>
  >(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [operationState, dispatch] = useReducer(operationReducer, { status: "idle" });
  const [storageUsed, setStorageUsed] = useState(0);
  const [downloadedCount, setDownloadedCount] = useState(0);

  // Derive values from operation state
  const isPreviewing =
    operationState.status === "previewing" || operationState.status === "previewing_error";
  const previewingVoiceId = isPreviewing ? operationState.voiceId : null;
  const error =
    operationState.status === "error" || operationState.status === "previewing_error"
      ? operationState.error
      : null;
  const lastErrorInfo =
    operationState.status === "error" || operationState.status === "previewing_error"
      ? operationState.errorInfo
      : null;
  const failedVoiceId =
    operationState.status === "error" || operationState.status === "previewing_error"
      ? operationState.failedVoiceId
      : null;

  // Track if component is mounted to avoid state updates after unmount
  const isMountedRef = useRef(true);

  // Voice cache reference for storage operations
  const voiceCacheRef = useRef<VoiceCache | null>(null);

  // Get or create the voice cache
  const getVoiceCache = useCallback(() => {
    if (!voiceCacheRef.current) {
      voiceCacheRef.current = new VoiceCache();
    }
    return voiceCacheRef.current;
  }, []);

  // Update storage statistics
  const updateStorageStats = useCallback(async () => {
    try {
      const cache = getVoiceCache();
      const entries = await cache.list();
      const size = await cache.getStorageSize();

      if (isMountedRef.current) {
        setStorageUsed(size);
        setDownloadedCount(entries.length);
      }
    } catch {
      // Silently fail - keep existing stats
    }
  }, [getVoiceCache]);

  // Initialize voice states
  useEffect(() => {
    isMountedRef.current = true;

    const loadVoiceStatus = async () => {
      try {
        const provider = getPiperTTSProvider();
        const storedVoices = await provider.getStoredVoiceIds();
        const storedSet = new Set(storedVoices);

        if (!isMountedRef.current) return;

        const initialStates = new Map<string, { status: VoiceDownloadStatus; progress: number }>();
        for (const voice of ENHANCED_VOICES) {
          initialStates.set(voice.id, {
            status: storedSet.has(voice.id) ? "downloaded" : "not-downloaded",
            progress: 0,
          });
        }
        setVoiceStates(initialStates);

        // Update storage statistics
        await updateStorageStats();
      } catch {
        // If storage check fails, assume not downloaded
        const initialStates = new Map<string, { status: VoiceDownloadStatus; progress: number }>();
        for (const voice of ENHANCED_VOICES) {
          initialStates.set(voice.id, { status: "not-downloaded", progress: 0 });
        }
        if (isMountedRef.current) {
          setVoiceStates(initialStates);
        }
      } finally {
        if (isMountedRef.current) {
          setIsLoading(false);
        }
      }
    };

    void loadVoiceStatus();

    return () => {
      isMountedRef.current = false;
    };
  }, [updateStorageStats]);

  // Refresh status from storage
  const refreshStatus = useCallback(async () => {
    try {
      const provider = getPiperTTSProvider();
      const storedVoices = await provider.getStoredVoiceIds();
      const storedSet = new Set(storedVoices);

      if (!isMountedRef.current) return;

      setVoiceStates((prev) => {
        const newStates = new Map(prev);
        for (const voice of ENHANCED_VOICES) {
          const current = newStates.get(voice.id);
          // Only update if not currently downloading
          if (current?.status !== "downloading") {
            newStates.set(voice.id, {
              status: storedSet.has(voice.id) ? "downloaded" : "not-downloaded",
              progress: 0,
            });
          }
        }
        return newStates;
      });

      // Update storage statistics
      await updateStorageStats();
    } catch {
      // Silently fail - keep existing state
    }
  }, [updateStorageStats]);

  // Download a voice
  const downloadVoice = useCallback(
    async (voiceId: string, isRetry = false) => {
      dispatch({ type: "CLEAR_ERROR" });

      // Update status to downloading and clear any previous error
      setVoiceStates((prev) => {
        const newStates = new Map(prev);
        newStates.set(voiceId, { status: "downloading", progress: 0, errorInfo: undefined });
        return newStates;
      });

      try {
        const provider = getPiperTTSProvider();
        await provider.downloadVoice(voiceId, (progress) => {
          if (!isMountedRef.current) return;
          setVoiceStates((prev) => {
            const newStates = new Map(prev);
            newStates.set(voiceId, { status: "downloading", progress, errorInfo: undefined });
            return newStates;
          });
        });

        if (!isMountedRef.current) return;

        // Update status to downloaded
        setVoiceStates((prev) => {
          const newStates = new Map(prev);
          newStates.set(voiceId, { status: "downloaded", progress: 1, errorInfo: undefined });
          return newStates;
        });

        // Track successful download
        trackEnhancedVoiceDownloadCompleted(voiceId);

        // Update storage statistics
        await updateStorageStats();
      } catch (err) {
        if (!isMountedRef.current) return;

        // Get detailed error information
        const errorInfo = getVoiceErrorInfo(err);

        // If it's a corrupted cache error and this isn't already a retry,
        // try to clear the cache entry and retry once
        if (errorInfo.type === "corrupted_cache" && !isRetry) {
          try {
            const cache = getVoiceCache();
            await cache.delete(voiceId);
            // Retry the download
            await downloadVoice(voiceId, true);
            return;
          } catch {
            // If clearing cache fails, fall through to normal error handling
          }
        }

        // Update status with error info
        setVoiceStates((prev) => {
          const newStates = new Map(prev);
          newStates.set(voiceId, { status: "not-downloaded", progress: 0, errorInfo });
          return newStates;
        });

        // Track failed voice ID for retry
        dispatch({
          type: "SET_ERROR",
          error: errorInfo.message,
          errorInfo,
          failedVoiceId: voiceId,
        });

        // Track failed download with error classification for telemetry
        const telemetryErrorType = classifyDownloadError(err);
        trackEnhancedVoiceDownloadFailed(voiceId, telemetryErrorType);
      }
    },
    [updateStorageStats, getVoiceCache]
  );

  // Remove a downloaded voice
  const removeVoice = useCallback(
    async (voiceId: string) => {
      dispatch({ type: "CLEAR_ERROR" });

      try {
        const provider = getPiperTTSProvider();
        await provider.removeVoice(voiceId);

        if (!isMountedRef.current) return;

        // Update status to not downloaded
        setVoiceStates((prev) => {
          const newStates = new Map(prev);
          newStates.set(voiceId, { status: "not-downloaded", progress: 0 });
          return newStates;
        });

        // Update storage statistics
        await updateStorageStats();
      } catch (err) {
        if (!isMountedRef.current) return;

        const message = err instanceof Error ? err.message : "Failed to remove voice";
        const errorInfo = getVoiceErrorInfo(err);
        dispatch({ type: "SET_ERROR", error: message, errorInfo, failedVoiceId: null });
      }
    },
    [updateStorageStats]
  );

  // Preview a voice
  const previewVoice = useCallback(async (voiceId: string) => {
    dispatch({ type: "START_PREVIEW", voiceId });

    try {
      const provider = getPiperTTSProvider();
      await provider.speak(PREVIEW_TEXT, {
        voiceId,
        rate: 1.0,
        onEnd: () => {
          if (!isMountedRef.current) return;
          dispatch({ type: "STOP_PREVIEW" });
        },
        onError: (err) => {
          if (!isMountedRef.current) return;
          dispatch({ type: "STOP_PREVIEW" });
          const errorInfo = getVoiceErrorInfo(err);
          dispatch({ type: "SET_ERROR", error: err.message, errorInfo, failedVoiceId: null });
        },
      });
    } catch (err) {
      if (!isMountedRef.current) return;
      dispatch({ type: "STOP_PREVIEW" });
      const message = err instanceof Error ? err.message : "Failed to preview voice";
      const errorInfo = getVoiceErrorInfo(err);
      dispatch({ type: "SET_ERROR", error: message, errorInfo, failedVoiceId: null });
    }
  }, []);

  // Stop current preview
  const stopPreview = useCallback(() => {
    const provider = getPiperTTSProvider();
    provider.stop();
    dispatch({ type: "STOP_PREVIEW" });
  }, []);

  // Clear error
  const clearError = useCallback(() => {
    dispatch({ type: "CLEAR_ERROR" });
    // Also clear error info from voice states
    setVoiceStates((prev) => {
      const newStates = new Map(prev);
      for (const [voiceId, state] of prev) {
        if (state.errorInfo) {
          newStates.set(voiceId, { ...state, errorInfo: undefined });
        }
      }
      return newStates;
    });
  }, []);

  // Retry the last failed download
  const retryDownload = useCallback(async () => {
    if (failedVoiceId) {
      await downloadVoice(failedVoiceId);
    }
  }, [failedVoiceId, downloadVoice]);

  // Clear the error for a specific voice and retry
  const retryVoiceDownload = useCallback(
    async (voiceId: string) => {
      // Clear the error for this specific voice
      setVoiceStates((prev) => {
        const newStates = new Map(prev);
        const current = prev.get(voiceId);
        if (current) {
          newStates.set(voiceId, { ...current, errorInfo: undefined });
        }
        return newStates;
      });
      // Clear global error if this was the failed voice
      if (failedVoiceId === voiceId) {
        dispatch({ type: "CLEAR_ERROR" });
      }
      // Retry the download
      await downloadVoice(voiceId);
    },
    [failedVoiceId, downloadVoice]
  );

  // Delete all cached voices
  const deleteAllVoices = useCallback(async () => {
    dispatch({ type: "CLEAR_ERROR" });

    try {
      const provider = getPiperTTSProvider();
      const storedVoices = await provider.getStoredVoiceIds();

      // Delete each voice
      for (const voiceId of storedVoices) {
        await provider.removeVoice(voiceId);
      }

      if (!isMountedRef.current) return;

      // Reset all voice states to not downloaded
      setVoiceStates((prev) => {
        const newStates = new Map(prev);
        for (const voice of ENHANCED_VOICES) {
          newStates.set(voice.id, { status: "not-downloaded", progress: 0 });
        }
        return newStates;
      });

      // Update storage statistics
      await updateStorageStats();
    } catch (err) {
      if (!isMountedRef.current) return;

      const message = err instanceof Error ? err.message : "Failed to delete voices";
      const errorInfo = getVoiceErrorInfo(err);
      dispatch({ type: "SET_ERROR", error: message, errorInfo, failedVoiceId: null });
    }
  }, [updateStorageStats]);

  // Calculate if storage limit is exceeded (memoized)
  const isStorageLimitExceededValue = useMemo(
    () => storageUsed > STORAGE_LIMIT_BYTES,
    [storageUsed]
  );

  // Build the voices array with current state (memoized to avoid rebuilding on every render)
  const voices: EnhancedVoiceState[] = useMemo(
    () =>
      ENHANCED_VOICES.map((voice) => {
        const state = voiceStates.get(voice.id) ?? {
          status: "not-downloaded" as const,
          progress: 0,
          errorInfo: undefined,
        };
        return {
          voice,
          status: state.status,
          progress: state.progress,
          errorInfo: state.errorInfo,
        };
      }),
    [voiceStates]
  );

  return {
    voices,
    isLoading,
    downloadVoice: (voiceId: string) => downloadVoice(voiceId, false),
    removeVoice,
    previewVoice,
    stopPreview,
    isPreviewing,
    previewingVoiceId,
    refreshStatus,
    error,
    lastErrorInfo,
    failedVoiceId,
    clearError,
    retryDownload,
    retryVoiceDownload,
    storageUsed,
    downloadedCount,
    isStorageLimitExceeded: isStorageLimitExceededValue,
    deleteAllVoices,
  };
}

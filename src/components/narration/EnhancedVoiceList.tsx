/**
 * EnhancedVoiceList Component
 *
 * Displays a list of enhanced Piper TTS voices with download status,
 * progress indicators, and preview/delete controls.
 *
 * @module components/narration/EnhancedVoiceList
 */

"use client";

import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  CheckIcon,
  AlertCircleIcon,
  SpinnerIcon,
  StopIcon,
  PlayIcon,
  TrashIcon,
  RefreshIcon,
  DownloadIcon,
  CloseIcon,
  AlertIcon,
} from "@/components/ui/icon-button";
import type { NarrationSettings } from "@/lib/narration/settings";
import { useEnhancedVoices, type EnhancedVoiceState } from "./useEnhancedVoices";
import { trackEnhancedVoiceSelected } from "@/lib/telemetry";

/**
 * Props for the EnhancedVoiceList component.
 */
interface EnhancedVoiceListProps {
  /**
   * Current narration settings.
   */
  settings: NarrationSettings;

  /**
   * Callback to update settings.
   */
  setSettings: (settings: NarrationSettings) => void;
}

/**
 * Formats bytes to a human-readable size string in MB.
 *
 * @param bytes - Size in bytes.
 * @returns Formatted size string (e.g., "50 MB").
 */
function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Math.round(mb)} MB`;
}

/**
 * Progress bar component for download progress.
 */
function ProgressBar({ progress, size }: { progress: number; size: number }) {
  const percent = Math.round(progress * 100);
  const downloadedMB = Math.round((progress * size) / (1024 * 1024));
  const totalMB = Math.round(size / (1024 * 1024));

  return (
    <div className="mt-2">
      <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div
          className="h-full rounded-full bg-zinc-900 transition-all duration-200 dark:bg-zinc-400"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="ui-text-xs mt-1 text-zinc-500 dark:text-zinc-400">
        {percent}% ({downloadedMB} MB / {totalMB} MB)
      </p>
    </div>
  );
}

/**
 * Single voice item in the list.
 */
function VoiceItem({
  voiceState,
  isSelected,
  onSelect,
  onDownload,
  onRetry,
  onPreview,
  onStopPreview,
  onDelete,
  isPreviewing,
  isThisVoicePreviewing,
}: {
  voiceState: EnhancedVoiceState;
  isSelected: boolean;
  onSelect: () => void;
  onDownload: () => void;
  onRetry: () => void;
  onPreview: () => void;
  onStopPreview: () => void;
  onDelete: () => void;
  isPreviewing: boolean;
  isThisVoicePreviewing: boolean;
}) {
  const { voice, status, progress, errorInfo } = voiceState;
  const isDownloading = status === "downloading";
  const isDownloaded = status === "downloaded";
  const hasError = errorInfo !== undefined;

  // Handle click on the voice item (for selection)
  const handleClick = useCallback(() => {
    if (isDownloaded) {
      onSelect();
    }
  }, [isDownloaded, onSelect]);

  // Handle keyboard selection
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (isDownloaded) {
          onSelect();
        }
      }
    },
    [isDownloaded, onSelect]
  );

  return (
    <div
      className={`relative rounded-lg border p-4 transition-colors ${
        isSelected
          ? "border-zinc-900 bg-zinc-50 dark:border-zinc-400 dark:bg-zinc-800"
          : isDownloaded
            ? "cursor-pointer border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800/50"
            : "border-zinc-200 dark:border-zinc-700"
      }`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role={isDownloaded ? "radio" : undefined}
      aria-checked={isDownloaded ? isSelected : undefined}
      tabIndex={isDownloaded ? 0 : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        {/* Left side: radio button + voice info */}
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {/* Radio button (only for downloaded voices) */}
          <div
            className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border ${
              isSelected
                ? "border-zinc-900 dark:border-zinc-400"
                : isDownloaded
                  ? "border-zinc-400 dark:border-zinc-500"
                  : "border-zinc-300 dark:border-zinc-600"
            }`}
          >
            {isSelected && <div className="h-2 w-2 rounded-full bg-zinc-900 dark:bg-zinc-400" />}
          </div>

          {/* Voice info */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {voice.displayName}
              </span>
              <span className="ui-text-xs text-zinc-500 dark:text-zinc-400">
                - {voice.description}
              </span>
            </div>

            {/* Status line */}
            {isDownloading ? (
              <ProgressBar progress={progress} size={voice.sizeBytes} />
            ) : isDownloaded ? (
              <div className="ui-text-xs mt-1 flex items-center gap-1 text-green-600 dark:text-green-400">
                <CheckIcon className="h-3.5 w-3.5" />
                Downloaded
              </div>
            ) : hasError ? (
              <div className="mt-1 space-y-1">
                <div className="ui-text-xs flex items-center gap-1 text-red-600 dark:text-red-400">
                  <AlertCircleIcon className="h-3.5 w-3.5" />
                  {errorInfo.message}
                </div>
                {errorInfo.suggestion && (
                  <p className="ui-text-xs text-zinc-500 dark:text-zinc-400">
                    {errorInfo.suggestion}
                  </p>
                )}
              </div>
            ) : (
              <p className="ui-text-xs mt-1 text-zinc-500 dark:text-zinc-400">
                {formatSize(voice.sizeBytes)}
              </p>
            )}
          </div>
        </div>

        {/* Right side: action buttons */}
        <div className="flex flex-shrink-0 items-center gap-2">
          {isDownloading ? (
            // Cancel button during download (optional - just showing spinner for now)
            <div className="ui-text-xs flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
              <SpinnerIcon className="h-4 w-4" />
              Downloading...
            </div>
          ) : isDownloaded ? (
            <>
              {/* Preview button */}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  if (isThisVoicePreviewing) {
                    onStopPreview();
                  } else {
                    onPreview();
                  }
                }}
                disabled={isPreviewing && !isThisVoicePreviewing}
              >
                {isThisVoicePreviewing ? (
                  <>
                    <StopIcon className="mr-1 h-3.5 w-3.5" />
                    Stop
                  </>
                ) : (
                  <>
                    <PlayIcon className="mr-1 h-3.5 w-3.5" />
                    Preview
                  </>
                )}
              </Button>

              {/* Delete button */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                className="rounded-md p-2 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-300"
                title="Delete voice"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </>
          ) : hasError && errorInfo.retryable ? (
            /* Retry button for retryable errors */
            <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
              <RefreshIcon className="mr-1 h-3.5 w-3.5" />
              Retry
            </Button>
          ) : (
            /* Download button */
            <Button type="button" variant="secondary" size="sm" onClick={onDownload}>
              <DownloadIcon className="mr-1 h-3.5 w-3.5" />
              Download
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Enhanced voice list component.
 *
 * Displays all available enhanced voices with their download status
 * and provides controls for downloading, previewing, and deleting voices.
 *
 * @param props - Component props.
 * @returns The enhanced voice list component.
 *
 * @example
 * ```tsx
 * function Settings() {
 *   const [settings, setSettings] = useNarrationSettings();
 *
 *   return (
 *     <EnhancedVoiceList
 *       settings={settings}
 *       setSettings={setSettings}
 *     />
 *   );
 * }
 * ```
 */
export function EnhancedVoiceList({ settings, setSettings }: EnhancedVoiceListProps) {
  const {
    voices,
    isLoading,
    downloadVoice,
    removeVoice,
    previewVoice,
    stopPreview,
    isPreviewing,
    previewingVoiceId,
    error,
    lastErrorInfo,
    clearError,
    retryDownload,
    retryVoiceDownload,
    storageUsed,
    downloadedCount,
    isStorageLimitExceeded,
    deleteAllVoices,
  } = useEnhancedVoices();

  // Handle voice selection
  const handleSelectVoice = useCallback(
    (voiceId: string) => {
      setSettings({
        ...settings,
        voiceId,
      });
      // Track voice selection for metrics
      trackEnhancedVoiceSelected(voiceId);
    },
    [settings, setSettings]
  );

  // Handle voice deletion
  const handleDeleteVoice = useCallback(
    async (voiceId: string) => {
      await removeVoice(voiceId);
      // If the deleted voice was selected, clear the selection
      if (settings.voiceId === voiceId) {
        setSettings({
          ...settings,
          voiceId: null,
        });
      }
    },
    [removeVoice, settings, setSettings]
  );

  // Handle deleting all voices
  const handleDeleteAllVoices = useCallback(async () => {
    await deleteAllVoices();
    // Clear the selection
    setSettings({
      ...settings,
      voiceId: null,
    });
  }, [deleteAllVoices, settings, setSettings]);

  // Format storage size in MB
  const formatStorageSize = (bytes: number): string => {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <SpinnerIcon className="h-6 w-6 text-zinc-400" />
        <span className="ui-text-sm ml-2 text-zinc-500 dark:text-zinc-400">Loading voices...</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Error message */}
      {error && (
        <div className="rounded-md bg-red-50 p-3 dark:bg-red-900/20">
          <div className="ui-text-xs flex items-start gap-2 text-red-800 dark:text-red-200">
            <AlertCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="flex-1 space-y-1">
              <p>{error}</p>
              {lastErrorInfo?.suggestion && (
                <p className="text-red-600 dark:text-red-300">{lastErrorInfo.suggestion}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {lastErrorInfo?.retryable && (
                <button
                  type="button"
                  onClick={retryDownload}
                  className="text-red-600 underline hover:text-red-800 dark:text-red-300 dark:hover:text-red-100"
                >
                  Retry
                </button>
              )}
              <button
                type="button"
                onClick={clearError}
                className="text-red-600 hover:text-red-800 dark:text-red-300 dark:hover:text-red-100"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Storage limit warning */}
      {isStorageLimitExceeded && (
        <div className="ui-text-xs flex items-start gap-2 rounded-md bg-amber-50 p-3 text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          <AlertIcon className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span className="flex-1">
            Voice storage exceeds 200 MB. Consider removing unused voices to free up space.
          </span>
        </div>
      )}

      {/* Voice list */}
      {voices.map((voiceState) => (
        <VoiceItem
          key={voiceState.voice.id}
          voiceState={voiceState}
          isSelected={settings.voiceId === voiceState.voice.id}
          onSelect={() => handleSelectVoice(voiceState.voice.id)}
          onDownload={() => downloadVoice(voiceState.voice.id)}
          onRetry={() => retryVoiceDownload(voiceState.voice.id)}
          onPreview={() => previewVoice(voiceState.voice.id)}
          onStopPreview={stopPreview}
          onDelete={() => handleDeleteVoice(voiceState.voice.id)}
          isPreviewing={isPreviewing}
          isThisVoicePreviewing={previewingVoiceId === voiceState.voice.id}
        />
      ))}

      {/* Storage info section */}
      {downloadedCount > 0 && (
        <div className="flex items-center justify-between rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800/50">
          <span className="ui-text-xs text-zinc-600 dark:text-zinc-400">
            Storage used: {formatStorageSize(storageUsed)} ({downloadedCount}{" "}
            {downloadedCount === 1 ? "voice" : "voices"})
          </span>
          {downloadedCount > 1 && (
            <button
              type="button"
              onClick={handleDeleteAllVoices}
              className="ui-text-xs text-zinc-500 underline hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              Delete All
            </button>
          )}
        </div>
      )}

      {/* Info text */}
      <p className="ui-text-xs text-zinc-500 dark:text-zinc-400">
        Enhanced voices run entirely in your browser. Once downloaded, they work offline.
      </p>
    </div>
  );
}

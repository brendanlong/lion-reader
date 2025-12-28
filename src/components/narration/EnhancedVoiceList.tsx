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
import { Button } from "@/components/ui";
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
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
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
  onPreview: () => void;
  onStopPreview: () => void;
  onDelete: () => void;
  isPreviewing: boolean;
  isThisVoicePreviewing: boolean;
}) {
  const { voice, status, progress } = voiceState;
  const isDownloading = status === "downloading";
  const isDownloaded = status === "downloaded";

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
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {voice.displayName}
              </span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                - {voice.description}
              </span>
            </div>

            {/* Status line */}
            {isDownloading ? (
              <ProgressBar progress={progress} size={voice.sizeBytes} />
            ) : isDownloaded ? (
              <div className="mt-1 flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                Downloaded
              </div>
            ) : (
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                {formatSize(voice.sizeBytes)}
              </p>
            )}
          </div>
        </div>

        {/* Right side: action buttons */}
        <div className="flex flex-shrink-0 items-center gap-2">
          {isDownloading ? (
            // Cancel button during download (optional - just showing spinner for now)
            <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
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
                    <svg
                      className="mr-1 h-3.5 w-3.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"
                      />
                    </svg>
                    Stop
                  </>
                ) : (
                  <>
                    <svg className="mr-1 h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
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
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            </>
          ) : (
            /* Download button */
            <Button type="button" variant="secondary" size="sm" onClick={onDownload}>
              <svg
                className="mr-1 h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                />
              </svg>
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
    clearError,
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
        <svg className="h-6 w-6 animate-spin text-zinc-400" fill="none" viewBox="0 0 24 24">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
        <span className="ml-2 text-sm text-zinc-500 dark:text-zinc-400">Loading voices...</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Error message */}
      {error && (
        <div className="flex items-start gap-2 rounded-md bg-red-50 p-3 text-xs text-red-800 dark:bg-red-900/20 dark:text-red-200">
          <svg
            className="mt-0.5 h-4 w-4 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={clearError}
            className="text-red-600 hover:text-red-800 dark:text-red-300 dark:hover:text-red-100"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      )}

      {/* Storage limit warning */}
      {isStorageLimitExceeded && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          <svg
            className="mt-0.5 h-4 w-4 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
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
          <span className="text-xs text-zinc-600 dark:text-zinc-400">
            Storage used: {formatStorageSize(storageUsed)} ({downloadedCount}{" "}
            {downloadedCount === 1 ? "voice" : "voices"})
          </span>
          {downloadedCount > 1 && (
            <button
              type="button"
              onClick={handleDeleteAllVoices}
              className="text-xs text-zinc-500 underline hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              Delete All
            </button>
          )}
        </div>
      )}

      {/* Info text */}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Enhanced voices run entirely in your browser. Once downloaded, they work offline.
      </p>
    </div>
  );
}

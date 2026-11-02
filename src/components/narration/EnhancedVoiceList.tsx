/**
 * EnhancedVoiceList Component
 *
 * The enhanced voice model's download controls, and the voices it speaks
 * with, each with a preview.
 *
 * @module components/narration/EnhancedVoiceList
 */

"use client";

import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  CheckIcon,
  SpinnerIcon,
  StopIcon,
  PlayIcon,
  TrashIcon,
  DownloadIcon,
} from "@/components/ui/icons";
import {
  ENHANCED_VOICES,
  PHONON_DOWNLOAD_SIZE_BYTES,
  resolveEnhancedVoice,
  type EnhancedVoice,
} from "@/lib/narration/enhanced-voices";
import type { NarrationSettings } from "@/lib/narration/settings";
import { trackEnhancedVoiceSelected } from "@/lib/telemetry";
import { useEnhancedVoices, type UseEnhancedVoicesReturn } from "./useEnhancedVoices";

interface EnhancedVoiceListProps {
  settings: NarrationSettings;
  setSettings: (settings: NarrationSettings) => void;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function ModelDownload({
  modelStatus,
  progress,
  downloadModel,
  removeModel,
}: Pick<UseEnhancedVoicesReturn, "modelStatus" | "progress" | "downloadModel" | "removeModel">) {
  return (
    <div className="border-edge-strong epaper:border-fill-muted rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="ui-text-sm text-body font-medium">Voice model</p>
          <p className="ui-text-xs text-muted">
            {megabytes(PHONON_DOWNLOAD_SIZE_BYTES)}, for every voice below
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {modelStatus === "checking" ? (
            <SpinnerIcon className="text-faint h-4 w-4" />
          ) : modelStatus === "downloading" ? (
            <div className="ui-text-xs text-muted flex items-center gap-2">
              <SpinnerIcon className="h-4 w-4" />
              Downloading...
            </div>
          ) : modelStatus === "downloaded" ? (
            <>
              <span className="ui-text-xs text-success flex items-center gap-1">
                <CheckIcon className="h-3.5 w-3.5" />
                Downloaded
              </span>
              <IconButton
                icon={<TrashIcon className="h-4 w-4" />}
                aria-label="Delete voice model"
                title="Delete voice model"
                variant="subtle"
                onClick={() => void removeModel()}
              />
            </>
          ) : (
            <Button type="button" variant="secondary" size="sm" onClick={downloadModel}>
              <DownloadIcon className="mr-1 h-3.5 w-3.5" />
              Download
            </Button>
          )}
        </div>
      </div>
      {modelStatus === "downloading" && (
        <div className="mt-2">
          <div className="bg-fill-muted h-2 w-full overflow-hidden rounded-full">
            <div
              className="bg-control-selected h-full rounded-full"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <p className="ui-text-xs text-muted mt-1 tabular-nums">
            {Math.round(progress * 100)}% ({megabytes(progress * PHONON_DOWNLOAD_SIZE_BYTES)} /{" "}
            {megabytes(PHONON_DOWNLOAD_SIZE_BYTES)})
          </p>
        </div>
      )}
    </div>
  );
}

function VoiceItem({
  voice,
  isSelected,
  isAvailable,
  isPreviewing,
  isAnyPreviewing,
  onSelect,
  onPreview,
  onStopPreview,
}: {
  voice: EnhancedVoice;
  isSelected: boolean;
  isAvailable: boolean;
  isPreviewing: boolean;
  isAnyPreviewing: boolean;
  onSelect: () => void;
  onPreview: () => void;
  onStopPreview: () => void;
}) {
  const inputId = `enhanced-voice-${voice.id}`;

  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${
        isSelected
          ? "border-control-selected bg-surface-selected"
          : isAvailable
            ? "border-edge-strong epaper:border-fill-muted hover:bg-surface-muted cursor-pointer"
            : "border-edge-strong epaper:border-fill-muted"
      }`}
      // Clicking anywhere on the card is a shortcut for the radio; the radio
      // itself owns the keyboard behavior, so there is no key handler.
      onClick={isAvailable ? onSelect : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <input
            type="radio"
            id={inputId}
            name="enhanced-voice"
            value={voice.id}
            checked={isSelected}
            disabled={!isAvailable}
            onChange={onSelect}
            className={`mt-0.5 h-4 w-4 flex-shrink-0 appearance-none rounded-full border bg-clip-content p-[3px] ${
              isSelected
                ? "border-control-selected bg-control-selected"
                : isAvailable
                  ? "border-edge-emphasis bg-transparent"
                  : "border-edge-input bg-transparent"
            }`}
          />
          <div className="min-w-0 flex-1">
            <label htmlFor={inputId} className="ui-text-sm text-body font-medium">
              {voice.name}
            </label>
            <p className="ui-text-xs text-muted line-clamp-2">{voice.description}</p>
          </div>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            if (isPreviewing) onStopPreview();
            else onPreview();
          }}
          disabled={!isAvailable || (isAnyPreviewing && !isPreviewing)}
        >
          {isPreviewing ? (
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
      </div>
    </div>
  );
}

const LOCALES = [
  { locale: "en-US", label: "American English" },
  { locale: "en-GB", label: "British English" },
] as const;

export function EnhancedVoiceList({ settings, setSettings }: EnhancedVoiceListProps) {
  const {
    modelStatus,
    progress,
    downloadModel,
    removeModel,
    previewVoice,
    stopPreview,
    previewingVoiceId,
  } = useEnhancedVoices();
  const isAvailable = modelStatus === "downloaded";
  const selectedId = resolveEnhancedVoice(settings.voiceId).id;

  const handleSelectVoice = useCallback(
    (voiceId: string) => {
      setSettings({ ...settings, voiceId });
      trackEnhancedVoiceSelected(voiceId);
    },
    [settings, setSettings]
  );

  return (
    <div className="space-y-4">
      <ModelDownload
        modelStatus={modelStatus}
        progress={progress}
        downloadModel={downloadModel}
        removeModel={removeModel}
      />

      <div role="radiogroup" aria-label="Enhanced voices" className="space-y-4">
        {LOCALES.map(({ locale, label }) => (
          <div key={locale} className="space-y-2">
            <h4 className="ui-text-xs text-muted font-medium">{label}</h4>
            {ENHANCED_VOICES.filter((voice) => voice.locale === locale).map((voice) => (
              <VoiceItem
                key={voice.id}
                voice={voice}
                isSelected={selectedId === voice.id}
                isAvailable={isAvailable}
                isPreviewing={previewingVoiceId === voice.id}
                isAnyPreviewing={previewingVoiceId !== null}
                onSelect={() => handleSelectVoice(voice.id)}
                onPreview={() => void previewVoice(voice.id)}
                onStopPreview={stopPreview}
              />
            ))}
          </div>
        ))}
      </div>

      <p className="ui-text-xs text-muted">
        Enhanced voices run entirely in your browser. Once downloaded, they work offline.
      </p>
    </div>
  );
}

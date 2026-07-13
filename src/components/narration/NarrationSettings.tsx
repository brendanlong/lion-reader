/**
 * NarrationSettings Component
 *
 * Settings section for audio narration configuration.
 * Allows users to select a voice provider, choose a voice, adjust playback speed and pitch,
 * and preview how narration will sound.
 */

"use client";

import { useState, useEffect, useCallback, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { CardSection } from "@/components/ui/card";
import { AlertIcon, InfoCircleIcon } from "@/components/ui/icon-button";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { useNarrationSettings } from "@/lib/narration/settings";
import { getNarrationSupportInfo, isFirefox } from "@/lib/narration/feature-detection";
import { waitForVoices, rankVoices, findVoiceByUri } from "@/lib/narration/voices";
import type { TTSProviderId } from "@/lib/narration/types";
import { PREVIEW_TEXT } from "@/lib/narration/constants";
import { EnhancedVoicesHelp } from "./EnhancedVoicesHelp";
import { trpc } from "@/lib/trpc/client";

// Dynamic import with ssr: false to prevent piper-tts-web from being bundled for SSR.
// The piper library has conditional Node.js code with require('fs') that breaks the build.
const EnhancedVoiceList = dynamic(
  () => import("./EnhancedVoiceList").then((mod) => mod.EnhancedVoiceList),
  { ssr: false }
);

// No-op subscribe function for static values (browser capabilities don't change)
const noopSubscribe = () => () => {};

export function NarrationSettings() {
  const [settings, setSettings] = useNarrationSettings();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [isPreviewing, setIsPreviewing] = useState(false);

  // Use useSyncExternalStore to handle server/client differences without hydration mismatch
  // Server returns null, client returns actual support info
  const supportInfo = useSyncExternalStore(noopSubscribe, getNarrationSupportInfo, () => null);

  // Check if running in Firefox (has broken pause/resume)
  const isFirefoxBrowser = useSyncExternalStore(noopSubscribe, isFirefox, () => false);

  // Track voice loading state separately (starts true, set false when voices load)
  const [isLoadingVoices, setIsLoadingVoices] = useState(true);

  // Check if AI text processing is available (GROQ_API_KEY configured)
  const { data: aiAvailability } = trpc.narration.isAiTextProcessingAvailable.useQuery();
  const isAiTextProcessingAvailable = aiAvailability?.available ?? false;

  // Load voices on mount (only if supported)
  useEffect(() => {
    // Skip if we haven't checked support yet, or if not supported
    if (!supportInfo?.supported) {
      return;
    }

    let cancelled = false;
    waitForVoices().then((availableVoices) => {
      if (cancelled) return;
      const ranked = rankVoices(availableVoices);
      setVoices(ranked);
      setIsLoadingVoices(false);
    });

    return () => {
      cancelled = true;
    };
  }, [supportInfo?.supported]);

  // Get the currently selected voice object
  const selectedVoice = settings.voiceId ? findVoiceByUri(settings.voiceId) : null;

  // Handle voice selection change
  const handleVoiceChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value;
      setSettings((prev) => ({
        ...prev,
        voiceId: value || null,
      }));
    },
    [setSettings]
  );

  // Handle rate change
  const handleRateChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseFloat(e.target.value);
      setSettings((prev) => ({
        ...prev,
        rate: value,
      }));
    },
    [setSettings]
  );

  // Handle pitch change
  const handlePitchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseFloat(e.target.value);
      setSettings((prev) => ({
        ...prev,
        pitch: value,
      }));
    },
    [setSettings]
  );

  // Handle provider change
  const handleProviderChange = useCallback(
    (provider: TTSProviderId) => {
      // When switching providers, reset voiceId since voice IDs are provider-specific
      setSettings((prev) => ({
        ...prev,
        provider,
        voiceId: null,
      }));
    },
    [setSettings]
  );

  // Preview voice with current settings
  const handlePreview = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return;
    }

    // Cancel any ongoing speech
    speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(PREVIEW_TEXT);

    // Apply voice if selected
    if (selectedVoice) {
      utterance.voice = selectedVoice;
    } else if (voices.length > 0) {
      // Use first available voice if none selected
      utterance.voice = voices[0];
    }

    utterance.rate = settings.rate;
    utterance.pitch = settings.pitch;

    utterance.onstart = () => setIsPreviewing(true);
    utterance.onend = () => setIsPreviewing(false);
    utterance.onerror = () => setIsPreviewing(false);

    speechSynthesis.speak(utterance);
  }, [selectedVoice, voices, settings.rate, settings.pitch]);

  // Stop preview
  const handleStopPreview = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      speechSynthesis.cancel();
      setIsPreviewing(false);
    }
  }, []);

  // Show loading skeleton while checking support (avoids hydration mismatch)
  if (supportInfo === null) {
    return (
      <SettingsSection title="Narration">
        <div className="flex items-center justify-between">
          <div>
            <div className="bg-fill-muted h-5 w-32 animate-pulse rounded" />
            <div className="bg-fill-muted mt-2 h-4 w-48 animate-pulse rounded" />
          </div>
          <div className="bg-fill-muted h-6 w-11 animate-pulse rounded-full" />
        </div>
      </SettingsSection>
    );
  }

  // Show unsupported message if narration is not available
  if (!supportInfo.supported) {
    return (
      <SettingsSection title="Narration">
        <div className="flex items-start gap-3">
          <AlertIcon className="text-faint mt-0.5 h-5 w-5 flex-shrink-0" />
          <div>
            <p className="ui-text-sm text-strong font-medium">Narration Unavailable</p>
            <p className="ui-text-sm text-muted mt-1">{supportInfo.reason}</p>
            <p className="ui-text-xs text-faint mt-2">
              Try using Chrome, Safari, or Edge for the best narration experience.
            </p>
          </div>
        </div>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="Narration">
      {/* Enable/Disable Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="ui-text-sm text-strong font-medium">Enable narration</h3>
          <p className="ui-text-sm text-muted mt-1">Listen to articles using text-to-speech.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          onClick={() => setSettings((prev) => ({ ...prev, enabled: !prev.enabled }))}
          className={`focus:ring-focus focus:ring-offset-surface relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:ring-2 focus:ring-offset-2 focus:outline-none ${
            settings.enabled ? "bg-primary-solid" : "bg-fill-muted"
          }`}
        >
          <span
            aria-hidden="true"
            className={`bg-surface pointer-events-none inline-block h-5 w-5 transform rounded-full shadow ring-0 transition duration-200 ease-in-out ${
              settings.enabled ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {/* Voice Settings (only shown when enabled) */}
      {settings.enabled && (
        <CardSection className="space-y-6">
          {/* Voice Provider Selection */}
          <div>
            <h3 className="ui-text-sm text-strong mb-3 font-medium">Voice Provider</h3>
            <div className="space-y-3">
              {/* Browser Voices Option */}
              <label
                className={`relative flex cursor-pointer rounded-lg border p-4 transition-colors ${
                  settings.provider === "browser"
                    ? "border-control-selected bg-zinc-50 dark:bg-zinc-800"
                    : "border-edge-strong hover:bg-surface-muted"
                }`}
              >
                <input
                  type="radio"
                  name="voice-provider"
                  value="browser"
                  checked={settings.provider === "browser"}
                  onChange={() => handleProviderChange("browser")}
                  className="sr-only"
                />
                <div className="flex items-start gap-3">
                  <div
                    className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border ${
                      settings.provider === "browser"
                        ? "border-control-selected"
                        : "border-zinc-400 dark:border-zinc-500"
                    }`}
                  >
                    {settings.provider === "browser" && (
                      <div className="bg-control-selected h-2 w-2 rounded-full" />
                    )}
                  </div>
                  <div>
                    <span className="ui-text-sm text-strong block font-medium">Browser Voices</span>
                    <span className="ui-text-xs text-muted mt-0.5 block">
                      Uses your browser&apos;s built-in text-to-speech
                    </span>
                  </div>
                </div>
              </label>

              {/* Enhanced Voices Option */}
              <label
                className={`relative flex cursor-pointer rounded-lg border p-4 transition-colors ${
                  settings.provider === "piper"
                    ? "border-control-selected bg-zinc-50 dark:bg-zinc-800"
                    : "border-edge-strong hover:bg-surface-muted"
                }`}
              >
                <input
                  type="radio"
                  name="voice-provider"
                  value="piper"
                  checked={settings.provider === "piper"}
                  onChange={() => handleProviderChange("piper")}
                  className="sr-only"
                />
                <div className="flex items-start gap-3">
                  <div
                    className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border ${
                      settings.provider === "piper"
                        ? "border-control-selected"
                        : "border-zinc-400 dark:border-zinc-500"
                    }`}
                  >
                    {settings.provider === "piper" && (
                      <div className="bg-control-selected h-2 w-2 rounded-full" />
                    )}
                  </div>
                  <div>
                    <span className="ui-text-sm text-strong block font-medium">
                      Enhanced Voices
                    </span>
                    <span className="ui-text-xs text-muted mt-0.5 block">
                      Higher quality voices (requires download)
                    </span>
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Browser Voice Selector (only shown when browser provider selected) */}
          {settings.provider === "browser" && (
            <div>
              <label
                htmlFor="narration-voice"
                className="ui-text-sm text-body mb-1.5 block font-medium"
              >
                Voice
              </label>
              <div className="flex gap-3">
                <select
                  id="narration-voice"
                  value={settings.voiceId || ""}
                  onChange={handleVoiceChange}
                  disabled={isLoadingVoices}
                  className="ui-text-sm bg-surface text-strong border-edge-input focus:border-focus focus:ring-focus block flex-1 rounded-md border px-3 py-2 focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isLoadingVoices ? (
                    <option value="">Loading voices...</option>
                  ) : voices.length === 0 ? (
                    <option value="">No voices available</option>
                  ) : (
                    <>
                      <option value="">Default voice</option>
                      {voices.map((voice) => (
                        <option key={voice.voiceURI} value={voice.voiceURI}>
                          {voice.name}
                          {voice.localService ? "" : " (online)"}
                        </option>
                      ))}
                    </>
                  )}
                </select>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={isPreviewing ? handleStopPreview : handlePreview}
                  disabled={isLoadingVoices || voices.length === 0}
                >
                  {isPreviewing ? "Stop" : "Preview"}
                </Button>
              </div>
              <p className="ui-text-xs text-muted mt-1.5">
                Voices are provided by your browser. Chrome and Safari typically offer higher
                quality voices.
              </p>
            </div>
          )}

          {/* Enhanced Voices List (only shown when piper provider selected) */}
          {settings.provider === "piper" && (
            <div className="space-y-4">
              <div>
                <label className="ui-text-sm text-body mb-3 block font-medium">Select Voice</label>
                <EnhancedVoiceList settings={settings} setSettings={setSettings} />
              </div>
              <EnhancedVoicesHelp />
            </div>
          )}

          {/* Speed Slider */}
          <div>
            <label
              htmlFor="narration-rate"
              className="ui-text-sm text-body mb-1.5 block font-medium tabular-nums"
            >
              Speed: {settings.rate.toFixed(1)}x
            </label>
            <input
              id="narration-rate"
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={settings.rate}
              onChange={handleRateChange}
              className="bg-fill-muted h-2 w-full cursor-pointer appearance-none rounded-lg"
            />
            <div className="ui-text-xs text-faint mt-1 flex justify-between">
              <span>0.5x</span>
              <span>1.0x</span>
              <span>1.5x</span>
              <span>2.0x</span>
            </div>
          </div>

          {/* Pitch Slider (browser voices only - Piper doesn't support pitch control) */}
          {settings.provider === "browser" && (
            <div>
              <label
                htmlFor="narration-pitch"
                className="ui-text-sm text-body mb-1.5 block font-medium tabular-nums"
              >
                Pitch: {settings.pitch.toFixed(1)}x
              </label>
              <input
                id="narration-pitch"
                type="range"
                min="0.5"
                max="2"
                step="0.1"
                value={settings.pitch}
                onChange={handlePitchChange}
                className="bg-fill-muted h-2 w-full cursor-pointer appearance-none rounded-lg"
              />
              <div className="ui-text-xs text-faint mt-1 flex justify-between">
                <span>0.5x</span>
                <span>1.0x</span>
                <span>1.5x</span>
                <span>2.0x</span>
              </div>
            </div>
          )}

          {/* Processing Settings - only shown if AI text processing is available */}
          {isAiTextProcessingAvailable && (
            <div className="space-y-4">
              <h3 className="ui-text-sm text-strong font-medium">Processing</h3>

              {/* LLM Normalization Toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="ui-text-sm text-body">Use AI text processing</p>
                  <p className="ui-text-xs text-muted">
                    Improves narration quality by expanding abbreviations and formatting content
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.useLlmNormalization}
                  onClick={() =>
                    setSettings((prev) => ({
                      ...prev,
                      useLlmNormalization: !prev.useLlmNormalization,
                    }))
                  }
                  className={`focus:ring-focus focus:ring-offset-surface relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:ring-2 focus:ring-offset-2 focus:outline-none ${
                    settings.useLlmNormalization ? "bg-primary-solid" : "bg-fill-muted"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`bg-surface pointer-events-none inline-block h-5 w-5 transform rounded-full shadow ring-0 transition duration-200 ease-in-out ${
                      settings.useLlmNormalization ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            </div>
          )}

          {/* Highlighting Settings */}
          <div className="space-y-4">
            <h3 className="ui-text-sm text-strong font-medium">Highlighting</h3>

            {/* Highlight Current Paragraph Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <p className="ui-text-sm text-body">Highlight current paragraph</p>
                <p className="ui-text-xs text-muted">Visually highlight the paragraph being read</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.highlightEnabled}
                onClick={() =>
                  setSettings((prev) => ({ ...prev, highlightEnabled: !prev.highlightEnabled }))
                }
                className={`focus:ring-focus focus:ring-offset-surface relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:ring-2 focus:ring-offset-2 focus:outline-none ${
                  settings.highlightEnabled ? "bg-primary-solid" : "bg-fill-muted"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`bg-surface pointer-events-none inline-block h-5 w-5 transform rounded-full shadow ring-0 transition duration-200 ease-in-out ${
                    settings.highlightEnabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            {/* Auto-scroll to Current Paragraph Toggle */}
            <div className="flex items-center justify-between">
              <div>
                <p className="ui-text-sm text-body">Auto-scroll to current paragraph</p>
                <p className="ui-text-xs text-muted">
                  Automatically scroll the page to keep the current paragraph visible
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={settings.autoScrollEnabled}
                onClick={() =>
                  setSettings((prev) => ({ ...prev, autoScrollEnabled: !prev.autoScrollEnabled }))
                }
                className={`focus:ring-focus focus:ring-offset-surface relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:ring-2 focus:ring-offset-2 focus:outline-none ${
                  settings.autoScrollEnabled ? "bg-primary-solid" : "bg-fill-muted"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`bg-surface pointer-events-none inline-block h-5 w-5 transform rounded-full shadow ring-0 transition duration-200 ease-in-out ${
                    settings.autoScrollEnabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Firefox Warning */}
          {isFirefoxBrowser && (
            <div className="ui-text-xs bg-warning-subtle text-warning-subtle-foreground flex items-start gap-2 rounded-md p-3">
              <AlertIcon className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>
                Firefox has limited support for pausing narration. When you pause and resume,
                playback will restart from the beginning of the current paragraph.
              </span>
            </div>
          )}
        </CardSection>
      )}

      {/* Media Session Info */}
      {settings.enabled && supportInfo.mediaSession && (
        <CardSection>
          <div className="ui-text-xs text-muted flex items-start gap-2">
            <InfoCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>
              Your browser supports media controls. You can control playback using your keyboard
              media keys or lock screen controls.
            </span>
          </div>
        </CardSection>
      )}
    </SettingsSection>
  );
}

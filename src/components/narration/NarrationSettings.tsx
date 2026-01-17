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
import { Button } from "@/components/ui";
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
      setSettings({
        ...settings,
        voiceId: value || null,
      });
    },
    [settings, setSettings]
  );

  // Handle rate change
  const handleRateChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseFloat(e.target.value);
      setSettings({
        ...settings,
        rate: value,
      });
    },
    [settings, setSettings]
  );

  // Handle pitch change
  const handlePitchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseFloat(e.target.value);
      setSettings({
        ...settings,
        pitch: value,
      });
    },
    [settings, setSettings]
  );

  // Handle provider change
  const handleProviderChange = useCallback(
    (provider: TTSProviderId) => {
      // When switching providers, reset voiceId since voice IDs are provider-specific
      setSettings({
        ...settings,
        provider,
        voiceId: null,
      });
    },
    [settings, setSettings]
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
      <section>
        <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">Narration</h2>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-center justify-between">
            <div>
              <div className="h-5 w-32 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
              <div className="mt-2 h-4 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
            </div>
            <div className="h-6 w-11 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-700" />
          </div>
        </div>
      </section>
    );
  }

  // Show unsupported message if narration is not available
  if (!supportInfo.supported) {
    return (
      <section>
        <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">Narration</h2>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-start gap-3">
            <svg
              className="mt-0.5 h-5 w-5 flex-shrink-0 text-zinc-400 dark:text-zinc-500"
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
            <div>
              <p className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-100">
                Narration Unavailable
              </p>
              <p className="ui-text-sm mt-1 text-zinc-500 dark:text-zinc-400">
                {supportInfo.reason}
              </p>
              <p className="ui-text-xs mt-2 text-zinc-400 dark:text-zinc-500">
                Try using Chrome, Safari, or Edge for the best narration experience.
              </p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">Narration</h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        {/* Enable/Disable Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-50">
              Enable narration
            </h3>
            <p className="ui-text-sm mt-1 text-zinc-500 dark:text-zinc-400">
              Listen to articles using text-to-speech.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.enabled}
            onClick={() => setSettings({ ...settings, enabled: !settings.enabled })}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:outline-none dark:focus:ring-offset-zinc-900 ${
              settings.enabled ? "bg-zinc-900 dark:bg-zinc-50" : "bg-zinc-200 dark:bg-zinc-700"
            }`}
          >
            <span
              aria-hidden="true"
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out dark:bg-zinc-900 ${
                settings.enabled ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        {/* Voice Settings (only shown when enabled) */}
        {settings.enabled && (
          <div className="mt-6 space-y-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
            {/* Voice Provider Selection */}
            <div>
              <h3 className="ui-text-sm mb-3 font-medium text-zinc-900 dark:text-zinc-50">
                Voice Provider
              </h3>
              <div className="space-y-3">
                {/* Browser Voices Option */}
                <label
                  className={`relative flex cursor-pointer rounded-lg border p-4 transition-colors ${
                    settings.provider === "browser"
                      ? "border-zinc-900 bg-zinc-50 dark:border-zinc-400 dark:bg-zinc-800"
                      : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800/50"
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
                          ? "border-zinc-900 dark:border-zinc-400"
                          : "border-zinc-400 dark:border-zinc-500"
                      }`}
                    >
                      {settings.provider === "browser" && (
                        <div className="h-2 w-2 rounded-full bg-zinc-900 dark:bg-zinc-400" />
                      )}
                    </div>
                    <div>
                      <span className="ui-text-sm block font-medium text-zinc-900 dark:text-zinc-100">
                        Browser Voices
                      </span>
                      <span className="ui-text-xs mt-0.5 block text-zinc-500 dark:text-zinc-400">
                        Uses your browser&apos;s built-in text-to-speech
                      </span>
                    </div>
                  </div>
                </label>

                {/* Enhanced Voices Option */}
                <label
                  className={`relative flex cursor-pointer rounded-lg border p-4 transition-colors ${
                    settings.provider === "piper"
                      ? "border-zinc-900 bg-zinc-50 dark:border-zinc-400 dark:bg-zinc-800"
                      : "border-zinc-200 hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800/50"
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
                          ? "border-zinc-900 dark:border-zinc-400"
                          : "border-zinc-400 dark:border-zinc-500"
                      }`}
                    >
                      {settings.provider === "piper" && (
                        <div className="h-2 w-2 rounded-full bg-zinc-900 dark:bg-zinc-400" />
                      )}
                    </div>
                    <div>
                      <span className="ui-text-sm block font-medium text-zinc-900 dark:text-zinc-100">
                        Enhanced Voices
                      </span>
                      <span className="ui-text-xs mt-0.5 block text-zinc-500 dark:text-zinc-400">
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
                  className="ui-text-sm mb-1.5 block font-medium text-zinc-700 dark:text-zinc-300"
                >
                  Voice
                </label>
                <div className="flex gap-3">
                  <select
                    id="narration-voice"
                    value={settings.voiceId || ""}
                    onChange={handleVoiceChange}
                    disabled={isLoadingVoices}
                    className="ui-text-sm block flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-zinc-900 focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-zinc-400 dark:focus:ring-zinc-400"
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
                <p className="ui-text-xs mt-1.5 text-zinc-500 dark:text-zinc-400">
                  Voices are provided by your browser. Chrome and Safari typically offer higher
                  quality voices.
                </p>
              </div>
            )}

            {/* Enhanced Voices List (only shown when piper provider selected) */}
            {settings.provider === "piper" && (
              <div className="space-y-4">
                <div>
                  <label className="ui-text-sm mb-3 block font-medium text-zinc-700 dark:text-zinc-300">
                    Select Voice
                  </label>
                  <EnhancedVoiceList settings={settings} setSettings={setSettings} />
                </div>
                <EnhancedVoicesHelp />
              </div>
            )}

            {/* Speed Slider */}
            <div>
              <label
                htmlFor="narration-rate"
                className="ui-text-sm mb-1.5 block font-medium text-zinc-700 dark:text-zinc-300"
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
                className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-zinc-200 accent-zinc-900 dark:bg-zinc-700 dark:accent-zinc-400"
              />
              <div className="ui-text-xs mt-1 flex justify-between text-zinc-400 dark:text-zinc-500">
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
                  className="ui-text-sm mb-1.5 block font-medium text-zinc-700 dark:text-zinc-300"
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
                  className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-zinc-200 accent-zinc-900 dark:bg-zinc-700 dark:accent-zinc-400"
                />
                <div className="ui-text-xs mt-1 flex justify-between text-zinc-400 dark:text-zinc-500">
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
                <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-50">
                  Processing
                </h3>

                {/* LLM Normalization Toggle */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="ui-text-sm text-zinc-700 dark:text-zinc-300">
                      Use AI text processing
                    </p>
                    <p className="ui-text-xs text-zinc-500 dark:text-zinc-400">
                      Improves narration quality by expanding abbreviations and formatting content
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.useLlmNormalization}
                    onClick={() =>
                      setSettings({
                        ...settings,
                        useLlmNormalization: !settings.useLlmNormalization,
                      })
                    }
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:outline-none dark:focus:ring-offset-zinc-900 ${
                      settings.useLlmNormalization
                        ? "bg-zinc-900 dark:bg-zinc-50"
                        : "bg-zinc-200 dark:bg-zinc-700"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out dark:bg-zinc-900 ${
                        settings.useLlmNormalization ? "translate-x-5" : "translate-x-0"
                      }`}
                    />
                  </button>
                </div>
              </div>
            )}

            {/* Highlighting Settings */}
            <div className="space-y-4">
              <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-50">
                Highlighting
              </h3>

              {/* Highlight Current Paragraph Toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="ui-text-sm text-zinc-700 dark:text-zinc-300">
                    Highlight current paragraph
                  </p>
                  <p className="ui-text-xs text-zinc-500 dark:text-zinc-400">
                    Visually highlight the paragraph being read
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.highlightEnabled}
                  onClick={() =>
                    setSettings({ ...settings, highlightEnabled: !settings.highlightEnabled })
                  }
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:outline-none dark:focus:ring-offset-zinc-900 ${
                    settings.highlightEnabled
                      ? "bg-zinc-900 dark:bg-zinc-50"
                      : "bg-zinc-200 dark:bg-zinc-700"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out dark:bg-zinc-900 ${
                      settings.highlightEnabled ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>

              {/* Auto-scroll to Current Paragraph Toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="ui-text-sm text-zinc-700 dark:text-zinc-300">
                    Auto-scroll to current paragraph
                  </p>
                  <p className="ui-text-xs text-zinc-500 dark:text-zinc-400">
                    Automatically scroll the page to keep the current paragraph visible
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.autoScrollEnabled}
                  onClick={() =>
                    setSettings({ ...settings, autoScrollEnabled: !settings.autoScrollEnabled })
                  }
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:outline-none dark:focus:ring-offset-zinc-900 ${
                    settings.autoScrollEnabled
                      ? "bg-zinc-900 dark:bg-zinc-50"
                      : "bg-zinc-200 dark:bg-zinc-700"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out dark:bg-zinc-900 ${
                      settings.autoScrollEnabled ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Firefox Warning */}
            {isFirefoxBrowser && (
              <div className="ui-text-xs flex items-start gap-2 rounded-md bg-amber-50 p-3 text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
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
                <span>
                  Firefox has limited support for pausing narration. When you pause and resume,
                  playback will restart from the beginning of the current paragraph.
                </span>
              </div>
            )}
          </div>
        )}

        {/* Media Session Info */}
        {settings.enabled && supportInfo.mediaSession && (
          <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
            <div className="ui-text-xs flex items-start gap-2 text-zinc-500 dark:text-zinc-400">
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
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span>
                Your browser supports media controls. You can control playback using your keyboard
                media keys or lock screen controls.
              </span>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

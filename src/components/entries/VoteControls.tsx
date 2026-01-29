/**
 * VoteControls Component
 *
 * Vertical vote controls with up/down arrows stacked around the score.
 *
 * Vote cycling:
 * - Up: 0 -> +1 -> +2 -> 0 (clear)
 * - Down: 0 -> -1 -> -2 -> 0 (clear)
 * - Switching direction goes to first level of new direction
 *
 * Visual representation:
 * - +1/-1: single chevron (^/v)
 * - +2/-2: double chevron (^^/vv)
 *
 * Display score: explicitScore ?? implicitScore ?? 0
 * The display score drives the controls, so implicit state from
 * actions (star, mark-read-on-list) is reflected in the arrows.
 */

"use client";

import { useCallback } from "react";

interface VoteControlsProps {
  /** Explicit score set by user (-2 to +2), null if not voted */
  score: number | null;
  /** Implicit score computed from user actions (star, mark-read, etc.) */
  implicitScore: number;
  /** Called when user clicks to set a new explicit score */
  onSetScore: (score: number | null) => void;
}

/**
 * Computes the next explicit score when the user clicks up or down.
 *
 * @param displayScore - Current display score (explicit ?? implicit ?? 0)
 * @param direction - "up" or "down"
 * @returns The new explicit score to set (null = clear to show implicit)
 */
function computeNextScore(displayScore: number, direction: "up" | "down"): number | null {
  if (direction === "up") {
    if (displayScore <= 0) return 1;
    if (displayScore === 1) return 2;
    // displayScore >= 2: cycle to 0
    return 0;
  } else {
    if (displayScore >= 0) return -1;
    if (displayScore === -1) return -2;
    // displayScore <= -2: cycle to 0
    return 0;
  }
}

/**
 * Single chevron up icon - matches the standard icon viewBox.
 */
function SingleChevronUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
    </svg>
  );
}

/**
 * Single chevron down icon - matches the standard icon viewBox.
 */
function SingleChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

/**
 * Double chevron up icon for strong votes (+2).
 * Bottom arrow matches single chevron position, top arrow appears above.
 */
function DoubleChevronUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      {/* Top arrow (additional) */}
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 9l7-7 7 7" />
      {/* Bottom arrow (same position as single chevron) */}
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
    </svg>
  );
}

/**
 * Double chevron down icon for strong votes (-2).
 * Top arrow matches single chevron position, bottom arrow appears below.
 */
function DoubleChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      {/* Top arrow (same position as single chevron) */}
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
      {/* Bottom arrow (additional) */}
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 15l-7 7-7-7" />
    </svg>
  );
}

export function VoteControls({ score, implicitScore, onSetScore }: VoteControlsProps) {
  const displayScore = score ?? implicitScore ?? 0;

  const handleUpClick = useCallback(() => {
    onSetScore(computeNextScore(displayScore, "up"));
  }, [displayScore, onSetScore]);

  const handleDownClick = useCallback(() => {
    onSetScore(computeNextScore(displayScore, "down"));
  }, [displayScore, onSetScore]);

  // Determine visual states
  const upActive = displayScore > 0;
  const downActive = displayScore < 0;
  const strongUp = displayScore >= 2;
  const strongDown = displayScore <= -2;

  // Choose icons based on score magnitude
  const UpIcon = strongUp ? DoubleChevronUpIcon : SingleChevronUpIcon;
  const DownIcon = strongDown ? DoubleChevronDownIcon : SingleChevronDownIcon;

  return (
    <div className="inline-flex flex-col items-center">
      <button
        type="button"
        onClick={handleUpClick}
        className={`rounded p-0.5 transition-colors ${
          upActive
            ? strongUp
              ? "text-green-600 dark:text-green-400"
              : "text-green-500 dark:text-green-500"
            : "text-zinc-400 hover:text-green-500 dark:text-zinc-500 dark:hover:text-green-400"
        }`}
        aria-label={`Upvote (current score: ${displayScore})`}
      >
        <UpIcon className="h-7 w-7" />
      </button>
      <span
        className={`ui-text-sm min-w-[2rem] text-center leading-tight font-semibold tabular-nums ${
          displayScore > 0
            ? "text-green-600 dark:text-green-400"
            : displayScore < 0
              ? "text-red-600 dark:text-red-400"
              : "text-zinc-500 dark:text-zinc-400"
        }`}
      >
        {displayScore > 0 ? `+${displayScore}` : displayScore}
      </span>
      <button
        type="button"
        onClick={handleDownClick}
        className={`rounded p-0.5 transition-colors ${
          downActive
            ? strongDown
              ? "text-red-600 dark:text-red-400"
              : "text-red-500 dark:text-red-500"
            : "text-zinc-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400"
        }`}
        aria-label={`Downvote (current score: ${displayScore})`}
      >
        <DownIcon className="h-7 w-7" />
      </button>
    </div>
  );
}

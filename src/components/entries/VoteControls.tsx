/**
 * VoteControls Component
 *
 * LessWrong-style cycling vote controls with up/down arrows.
 *
 * Vote cycling:
 * - Up: 0 -> +1 -> +2 -> 0 (clear)
 * - Down: 0 -> -1 -> -2 -> 0 (clear)
 * - Switching direction goes to first level of new direction
 *
 * Display score: explicitScore ?? implicitScore ?? 0
 * The display score drives the controls, so implicit state from
 * actions (star, mark-read-on-list) is reflected in the arrows.
 */

"use client";

import { useCallback } from "react";
import { ChevronUpIcon, ChevronDownIcon } from "@/components/ui";

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

  return (
    <div className="inline-flex items-center gap-0.5">
      <button
        type="button"
        onClick={handleUpClick}
        className={`rounded p-1.5 transition-colors ${
          upActive
            ? strongUp
              ? "text-green-600 dark:text-green-400"
              : "text-green-500 dark:text-green-500"
            : "text-zinc-400 hover:text-green-500 dark:text-zinc-500 dark:hover:text-green-400"
        }`}
        aria-label={`Upvote (current score: ${displayScore})`}
      >
        <ChevronUpIcon className="h-5 w-5" />
      </button>
      <span
        className={`ui-text-xs min-w-[1.5rem] text-center font-medium tabular-nums ${
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
        className={`rounded p-1.5 transition-colors ${
          downActive
            ? strongDown
              ? "text-red-600 dark:text-red-400"
              : "text-red-500 dark:text-red-500"
            : "text-zinc-400 hover:text-red-500 dark:text-zinc-500 dark:hover:text-red-400"
        }`}
        aria-label={`Downvote (current score: ${displayScore})`}
      >
        <ChevronDownIcon className="h-5 w-5" />
      </button>
    </div>
  );
}

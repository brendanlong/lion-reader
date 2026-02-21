/**
 * StickyEntryControls Component
 *
 * A sticky bottom bar that shows star and read/unread controls
 * when the main action buttons have scrolled out of view.
 * Uses IntersectionObserver to detect when the main buttons are hidden.
 */

"use client";

import { useState, useEffect, type RefObject } from "react";
import {
  StarIcon,
  StarFilledIcon,
  CircleIcon,
  CircleFilledIcon,
} from "@/components/ui/icon-button";
import { useScrollContainer } from "@/components/layout/ScrollContainerContext";

interface StickyEntryControlsProps {
  /** Ref to the main action buttons element to observe */
  actionButtonsRef: RefObject<HTMLElement | null>;
  /** Whether the article is starred */
  starred: boolean;
  /** Whether the article has been read */
  read: boolean;
  /** Callback to toggle star status */
  onToggleStar: () => void;
  /** Callback to toggle read status */
  onToggleRead: () => void;
}

export function StickyEntryControls({
  actionButtonsRef,
  starred,
  read,
  onToggleStar,
  onToggleRead,
}: StickyEntryControlsProps) {
  const [isVisible, setIsVisible] = useState(false);
  const scrollContainerRef = useScrollContainer();

  useEffect(() => {
    const target = actionButtonsRef.current;
    if (!target) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Show sticky controls when the main buttons are NOT intersecting
        setIsVisible(!entry.isIntersecting);
      },
      {
        root: scrollContainerRef?.current ?? null,
        threshold: 0,
      }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [actionButtonsRef, scrollContainerRef]);

  if (!isVisible) return null;

  return (
    <div className="pointer-events-none sticky bottom-0 -mx-4 flex justify-center px-4 pb-4">
      <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-zinc-200 bg-white/95 px-3 py-1.5 shadow-lg backdrop-blur-sm dark:border-zinc-700 dark:bg-zinc-900/95">
        {/* Star button */}
        <button
          onClick={onToggleStar}
          className={`flex min-h-[36px] min-w-[36px] items-center justify-center rounded-full transition-colors ${
            starred
              ? "text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950"
              : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          }`}
          aria-label={starred ? "Remove from starred" : "Add to starred"}
        >
          {starred ? <StarFilledIcon className="h-5 w-5" /> : <StarIcon className="h-5 w-5" />}
        </button>

        {/* Divider */}
        <div className="h-5 w-px bg-zinc-200 dark:bg-zinc-700" />

        {/* Read/unread button */}
        <button
          onClick={onToggleRead}
          className={`flex min-h-[36px] min-w-[36px] items-center justify-center rounded-full transition-colors ${
            !read
              ? "text-accent hover:bg-accent-subtle"
              : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          }`}
          aria-label={read ? "Mark as unread" : "Mark as read"}
          title="Keyboard shortcut: m"
        >
          {read ? <CircleIcon className="h-5 w-5" /> : <CircleFilledIcon className="h-5 w-5" />}
        </button>
      </div>
    </div>
  );
}

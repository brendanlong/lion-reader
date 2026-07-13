/**
 * EntryStateButtons
 *
 * The Star and Read/Unread toggle buttons shown in the reader action bar.
 * Extracted so the real reader (EntryContentBody), its cold-load fallback
 * (EntryContentFallback), and the demo reader (DemoRouter) render byte-identical
 * buttons instead of three hand-maintained copies that can drift apart.
 *
 * Color language (see also EntryListItem / StickyEntryControls): amber is
 * reserved for the star — the starred state shows an amber `text-star` icon in
 * an otherwise-neutral secondary button, matching the star icon in the list.
 * The read/unread indicator is deliberately NEUTRAL: both states are secondary
 * buttons and the filled-vs-hollow circle icon + label carry read state, so
 * "unread" (the most common state) stays quiet.
 */

"use client";

import { Button } from "@/components/ui/button";
import {
  StarIcon,
  StarFilledIcon,
  CircleIcon,
  CircleFilledIcon,
} from "@/components/ui/icon-button";

interface StarButtonProps {
  starred: boolean;
  onToggle: () => void;
}

export function StarButton({ starred, onToggle }: StarButtonProps) {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={onToggle}
      aria-label={starred ? "Remove from starred" : "Add to starred"}
    >
      {starred ? (
        <StarFilledIcon className="text-star h-5 w-5" />
      ) : (
        <StarIcon className="h-5 w-5" />
      )}
      <span className="ml-2">{starred ? "Starred" : "Star"}</span>
    </Button>
  );
}

interface ReadToggleButtonProps {
  read: boolean;
  onToggle: () => void;
}

export function ReadToggleButton({ read, onToggle }: ReadToggleButtonProps) {
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={onToggle}
      aria-label={read ? "Mark as unread" : "Mark as read"}
      title="Keyboard shortcut: m"
    >
      {read ? <CircleIcon className="h-4 w-4" /> : <CircleFilledIcon className="h-4 w-4" />}
      <span className="ml-2">{read ? "Read" : "Unread"}</span>
    </Button>
  );
}

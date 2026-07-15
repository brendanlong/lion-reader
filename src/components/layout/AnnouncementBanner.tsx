/**
 * Announcement Banner
 *
 * A closeable bar rendered at the very top of every page (from the root layout).
 * The announcement is fetched server-side and passed in as a prop, so this needs
 * no client API call. Dismissal is stored in localStorage keyed by the
 * announcement's message-derived id: dismissing sticks for that exact message,
 * but a new/changed announcement gets a new id and re-appears.
 */

"use client";

import { useCallback, useState } from "react";
import { CloseIcon } from "@/components/ui/icon-button";
import { useLiveAnnouncement } from "@/lib/site-status/announcement-store";
import type { AnnouncementLevel } from "@/server/services/site-status";

const STORAGE_KEY = "lion-reader:announcement-dismissed";

const LEVEL_STYLES: Record<AnnouncementLevel, string> = {
  info: "bg-info-subtle text-info-subtle-foreground border-info-border",
  warning: "bg-warning-banner text-warning-banner-foreground border-transparent",
};

/**
 * Presentational banner. Shared with the admin preview so the operator sees
 * exactly what users will see. `onDismiss` is omitted in preview mode.
 */
export function AnnouncementBannerView({
  message,
  level,
  onDismiss,
}: {
  message: string;
  level: AnnouncementLevel;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="status"
      className={`flex items-start gap-3 border-b px-4 py-2.5 ${LEVEL_STYLES[level]}`}
    >
      <p className="ui-text-sm mx-auto max-w-4xl flex-1 text-center font-medium break-words whitespace-pre-wrap">
        {message}
      </p>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss announcement"
          className="focus:ring-focus -mr-1 shrink-0 rounded p-1 opacity-80 hover:opacity-100 focus:ring-2 focus:outline-none"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export interface AnnouncementBannerProps {
  announcement: { id: string; message: string; level: AnnouncementLevel } | null;
}

export function AnnouncementBanner({ announcement }: AnnouncementBannerProps) {
  // Live override from SSE (`announcement_changed`). `undefined` means no live
  // update has arrived, so we use the server-rendered initial value; `null`
  // means a live update cleared it (hide the banner).
  const live = useLiveAnnouncement();
  const current = live === undefined ? announcement : live;

  // Lazy init (SSR-safe): read the dismissed id once. Matches the localStorage
  // pattern in useKeyboardShortcutsEnabled.ts.
  const [dismissedId, setDismissedId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });

  const dismiss = useCallback(() => {
    if (!current) return;
    setDismissedId(current.id);
    try {
      localStorage.setItem(STORAGE_KEY, current.id);
    } catch {
      // localStorage unavailable (private browsing) — banner stays hidden for
      // this session via the state update above.
    }
  }, [current]);

  if (!current || dismissedId === current.id) return null;

  return (
    <AnnouncementBannerView message={current.message} level={current.level} onDismiss={dismiss} />
  );
}

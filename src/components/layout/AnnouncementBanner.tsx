/**
 * Announcement Banner
 *
 * A closeable bar rendered at the top of the authenticated SPA (from
 * src/app/(app)/layout.tsx — deliberately NOT the root layout, so a temporary
 * message is never baked into the CDN-cached public pages; see
 * src/server/http/page-cache.ts). The announcement is fetched server-side and
 * passed in as a prop, so this needs no client API call. Dismissal is keyed by
 * the announcement's message-derived id: dismissing sticks for that exact
 * message, but a new/changed announcement gets a new id and re-appears.
 *
 * The dismissed id lives in a **cookie** (not localStorage) so the server can
 * read it and render the banner already-hidden — otherwise a dismissed banner
 * flashes back on every reload (the server can't read localStorage) and the
 * SSR/client render diverge. The server passes the cookie value as
 * `initialDismissedId`.
 */

"use client";

import { useCallback, useState } from "react";
import { CloseIcon } from "@/components/ui/icon-button";
import { useLiveAnnouncement } from "@/lib/site-status/announcement-store";
import { ANNOUNCEMENT_DISMISSED_COOKIE } from "@/lib/site-status/announcement-cookie";
import type { AnnouncementLevel } from "@/server/services/site-status";

/** One year — dismissal should persist. */
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

function persistDismissedId(id: string): void {
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${ANNOUNCEMENT_DISMISSED_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
  } catch {
    // document.cookie can throw in sandboxed contexts — the state update below
    // still hides the banner for this session.
  }
}

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
          className="-mr-1 shrink-0 rounded p-1 opacity-80 hover:opacity-100"
        >
          <CloseIcon className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export interface AnnouncementBannerProps {
  announcement: { id: string; message: string; level: AnnouncementLevel } | null;
  /** The dismissed announcement id from the cookie (read server-side). */
  initialDismissedId: string | null;
}

export function AnnouncementBanner({ announcement, initialDismissedId }: AnnouncementBannerProps) {
  // Live override from SSE (`announcement_changed`). `undefined` means no live
  // update has arrived, so we use the server-rendered initial value; `null`
  // means a live update cleared it (hide the banner).
  const live = useLiveAnnouncement();
  const current = live === undefined ? announcement : live;

  // Seeded from the cookie the server already read, so the first client render
  // matches the SSR output (no hydration mismatch, no flash of a dismissed
  // banner). Updated locally when the user dismisses a live-pushed announcement.
  const [dismissedId, setDismissedId] = useState<string | null>(initialDismissedId);

  const dismiss = useCallback(() => {
    if (!current) return;
    setDismissedId(current.id);
    persistDismissedId(current.id);
  }, [current]);

  if (!current || dismissedId === current.id) return null;

  return (
    <AnnouncementBannerView message={current.message} level={current.level} onDismiss={dismiss} />
  );
}

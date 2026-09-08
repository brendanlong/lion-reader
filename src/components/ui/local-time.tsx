/**
 * LocalTime
 *
 * A `<time>` whose text is formatted in the visitor's clock and zone.
 *
 * Statically prerendered pages (the demo) bake the *server's* clock and zone
 * into the HTML — "just now" at build, or a UTC timestamp — and that text is
 * what the browser shows until something re-renders it. This re-renders once
 * right after hydration so the visitor gets their own time, and suppresses the
 * expected server/client text mismatch on the way. In the app, entries mount
 * after hydration and this is a plain `<time>`.
 */

"use client";

import { useIsHydrated } from "@/lib/hooks/useIsHydrated";

interface LocalTimeProps {
  date: Date;
  format: (date: Date) => string;
  className?: string;
}

export function LocalTime({ date, format, className }: LocalTimeProps) {
  // Subscribed only for its post-hydration re-render (see module comment).
  useIsHydrated();
  return (
    <time dateTime={date.toISOString()} className={className} suppressHydrationWarning>
      {format(date)}
    </time>
  );
}

/**
 * LocalTime
 *
 * A `<time>` whose text is formatted in the visitor's clock and zone.
 *
 * Server-rendered HTML bakes in the *server's* clock and zone — at request
 * time, or at build time for statically prerendered pages (the demo) — and
 * hydration keeps that text (React never patches a suppressed text mismatch).
 * So the element is remounted with the visitor's own time right after
 * hydration. Mounts after hydration render the visitor's time from the start.
 */

"use client";

import { useIsHydrated } from "@/lib/hooks/useIsHydrated";

interface LocalTimeProps {
  date: Date;
  format: (date: Date) => string;
  className?: string;
}

export function LocalTime({ date, format, className }: LocalTimeProps) {
  // A new key replaces the server-rendered node; re-rendering with the same
  // key would keep its text, which hydration left as the server's.
  const isHydrated = useIsHydrated();
  return (
    <time
      key={isHydrated ? "local" : "server"}
      dateTime={date.toISOString()}
      className={className}
      suppressHydrationWarning
    >
      {format(date)}
    </time>
  );
}

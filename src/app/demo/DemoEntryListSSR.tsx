/**
 * DemoEntryListSSR Component
 *
 * Server component that renders a static entry list with crawlable <a> links
 * for SEO. Shown during SSR when no ?entry= parameter is present.
 * After hydration, DemoLayoutContent switches to DemoRouter which replaces
 * this with the interactive client-side entry list.
 */

import { formatRelativeTime } from "@/lib/format";
import { type DemoEntry } from "./data";

interface DemoEntryListSSRProps {
  entries: DemoEntry[];
  backHref: string;
  title: string;
}

export function DemoEntryListSSR({ entries, backHref, title }: DemoEntryListSSRProps) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 flex items-center justify-between sm:mb-6">
        <h1 className="ui-text-xl sm:ui-text-2xl font-bold text-zinc-900 dark:text-zinc-50">
          {title}
        </h1>
      </div>
      <div className="space-y-3">
        {entries.map((entry) => {
          const displayTitle = entry.title ?? "Untitled";
          const source = entry.feedTitle ?? "Lion Reader";
          const date = entry.publishedAt ?? entry.fetchedAt;

          return (
            <a
              key={entry.id}
              href={`${backHref}?entry=${entry.id}`}
              className="group relative block cursor-pointer rounded-lg border border-zinc-300 bg-zinc-50 p-3 transition-colors hover:bg-zinc-100 active:bg-zinc-200 sm:p-4 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700/50 dark:active:bg-zinc-700"
            >
              <div className="flex items-start gap-3">
                <div className="mt-1.5 shrink-0">
                  <span
                    className="bg-accent-muted dark:bg-accent block h-2.5 w-2.5 rounded-full"
                    aria-hidden="true"
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="ui-text-sm line-clamp-2 font-medium text-zinc-900 dark:text-zinc-100">
                    {displayTitle}
                  </h3>
                  <div className="ui-text-xs mt-1 flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
                    <span className="truncate">{source}</span>
                    <span aria-hidden="true">&middot;</span>
                    <time dateTime={date.toISOString()} className="shrink-0">
                      {formatRelativeTime(date)}
                    </time>
                  </div>
                  {entry.summary && (
                    <p className="ui-text-sm mt-2 line-clamp-2 text-zinc-600 dark:text-zinc-400">
                      {entry.summary}
                    </p>
                  )}
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}

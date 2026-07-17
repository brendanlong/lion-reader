/**
 * DemoEntryListSSR Component
 *
 * Server component that renders a static entry list with crawlable <a> links
 * for SEO. Shown during SSR when no ?entry= parameter is present.
 * After hydration, DemoLayoutContent switches to DemoRouter which replaces
 * this with the interactive client-side entry list.
 */

import { formatRelativeTime } from "@/lib/format";
import { getItemClasses } from "@/components/entries/entryItemClasses";
import { StarIcon, StarFilledIcon } from "@/components/ui/icon-button";
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
        <h1 className="ui-text-xl sm:ui-text-2xl text-body font-bold">{title}</h1>
      </div>
      <div className="space-y-3">
        {entries.map((entry) => {
          const displayTitle = entry.title ?? "Untitled";
          const source = entry.feedTitle ?? "Lion Reader";
          const date = entry.publishedAt ?? entry.fetchedAt;

          return (
            // Uses the same class helper as the interactive EntryListItem (unread,
            // comfortable) so this crawlable-anchor list is pixel-identical to the
            // post-hydration list and the swap in DemoLayoutContent shows no flash.
            // The interactive item can't be reused directly here: it renders an
            // <article role="button"> with nested star/read <button>s (invalid and
            // uncrawlable inside an <a>), so we keep this stripped-down anchor.
            <a
              key={entry.id}
              href={`${backHref}?entry=${entry.id}`}
              className={`${getItemClasses(false)} block`}
            >
              <div className="flex items-start gap-3">
                <div className="mt-1.5 shrink-0">
                  <span className="bg-body block h-2.5 w-2.5 rounded-full" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  {/* Title + star, mirroring EntryListItem's resting layout so the
                      star doesn't pop in on hydration. The star is a static icon
                      here (not a toggle button) because a <button> can't nest in
                      an <a>; it matches the interactive item's at-rest appearance:
                      the -m/p touch-target padding there nets to the same 16px box. */}
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="ui-text-sm text-body line-clamp-2 font-semibold">
                      {displayTitle}
                    </h3>
                    <span
                      className={`shrink-0 ${entry.starred ? "text-star" : "text-zinc-300 dark:text-zinc-600"}`}
                      aria-hidden="true"
                    >
                      {entry.starred ? (
                        <StarFilledIcon className="h-4 w-4" />
                      ) : (
                        <StarIcon className="h-4 w-4" />
                      )}
                    </span>
                  </div>
                  <div className="ui-text-xs text-muted mt-1 flex items-center gap-2">
                    <span className="truncate">{source}</span>
                    <span aria-hidden="true">&middot;</span>
                    <time dateTime={date.toISOString()} className="shrink-0">
                      {formatRelativeTime(date)}
                    </time>
                  </div>
                  {entry.summary && (
                    <p className="ui-text-sm text-muted mt-2 line-clamp-2">{entry.summary}</p>
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

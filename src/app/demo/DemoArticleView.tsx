/**
 * DemoArticleView Component
 *
 * The full interactive demo article view (back link, star/read/summarize
 * actions, summary card, per-article CTAs, and reader text styles).
 *
 * Rendered by BOTH the SSR route pages (src/app/demo/**\/page.tsx) and the
 * client-side DemoRouter, so the server HTML and the post-hydration render are
 * identical. This is what keeps the "Back to list" link, the action buttons,
 * the welcome CTA, and the reader font/size from popping in after hydration —
 * they're in the SSR HTML because the same component produces both. Live
 * read/starred state comes from DemoStateContext (defaults on the server, which
 * matches the client's first render), so there is no hydration mismatch.
 */

"use client";

import { useState } from "react";
import { ClientLink } from "@/components/ui/client-link";
import { PageLink } from "@/components/ui/page-link";
import { ScrollContainer } from "@/components/layout/ScrollContainerContext";
import { Button } from "@/components/ui/button";
import { ArrowLeftIcon, SparklesIcon } from "@/components/ui/icon-button";
import { StarButton, ReadToggleButton } from "@/components/entries/EntryStateButtons";
import { EntryArticle } from "@/components/entries/EntryArticle";
import { SummaryCard } from "@/components/summarization/SummaryCard";
import { AppearanceSettings } from "@/components/settings/AppearanceSettings";
import { useEntryTextStyles } from "@/lib/appearance/AppearanceProvider";
import { getDemoEntryArticleProps, type DemoEntry } from "./data";
import { useDemoState } from "./DemoStateContext";

interface DemoArticleViewProps {
  /** The entry to render (live read/starred state is read from DemoStateContext). */
  entry: DemoEntry;
  /** Href for the "Back to list" link (the current list view). */
  backHref: string;
  /** Swipe gesture handlers, supplied by DemoRouter for prev/next navigation. */
  onTouchStart?: React.TouchEventHandler;
  onTouchEnd?: React.TouchEventHandler;
}

export function DemoArticleView({
  entry,
  backHref,
  onTouchStart,
  onTouchEnd,
}: DemoArticleViewProps) {
  const demoState = useDemoState();
  // Apply the user's appearance settings (font, size, alignment) to the demo
  // article content, matching EntryContentBody in the real app. The CSS vars are
  // set by the head script before first paint, so the SSR HTML already carries
  // the correct font/size and there is no flash on hydration.
  const { className: textSizeClass, style: textStyle } = useEntryTextStyles();
  const [showSummary, setShowSummary] = useState(false);

  const { read, starred } = demoState.getEntryState(entry.id);

  return (
    <ScrollContainer className="h-full overflow-y-auto">
      <EntryArticle
        {...getDemoEntryArticleProps(entry)}
        textSizeClass={textSizeClass}
        textStyle={textStyle}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        backButton={
          <ClientLink
            href={backHref}
            className="ui-text-sm text-muted hover:bg-surface-muted hover:text-body mb-4 -ml-2 inline-flex min-h-[44px] items-center gap-2 rounded-md px-2 transition-colors active:bg-zinc-200 sm:mb-6 dark:active:bg-zinc-700"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            <span>Back to list</span>
          </ClientLink>
        }
        actionButtons={
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {/* Star + Read/Unread toggles (shared with the real reader) */}
            <StarButton starred={starred} onToggle={() => demoState.toggleStar(entry.id)} />
            <ReadToggleButton read={read} onToggle={() => demoState.toggleRead(entry.id)} />

            {/* Summarize button */}
            <Button
              variant={showSummary ? "primary" : "secondary"}
              size="sm"
              onClick={() => setShowSummary((prev) => !prev)}
              aria-label={showSummary ? "Hide summary" : "Show AI summary"}
            >
              <SparklesIcon className="h-4 w-4" />
              <span className="ml-2">{showSummary ? "Hide Summary" : "Summarize"}</span>
            </Button>
          </div>
        }
        beforeContent={
          <>
            {showSummary && (
              <SummaryCard
                summary={entry.summaryHtml}
                modelId="claude-sonnet-4-6"
                generatedAt={new Date("2026-02-07")}
                onClose={() => setShowSummary(false)}
              />
            )}
            {entry.id === "welcome" && (
              <div className="border-edge-strong bg-surface-subtle mb-6 rounded-lg border p-6 text-center">
                <h2 className="text-body mb-4 text-2xl font-semibold">Get Started</h2>
                <div className="flex flex-col justify-center gap-3 sm:flex-row sm:items-center">
                  <PageLink
                    href="/register"
                    className="btn-primary ui-text-base inline-flex h-12 w-full items-center justify-center rounded-md px-6 font-medium sm:w-auto"
                  >
                    Sign Up
                  </PageLink>
                  <PageLink
                    href="/login"
                    className="ui-text-base bg-surface text-body border-edge-input hover:bg-surface-muted inline-flex h-12 w-full items-center justify-center rounded-md border px-6 font-medium transition-colors sm:w-auto"
                  >
                    Sign in
                  </PageLink>
                </div>
              </div>
            )}
          </>
        }
        afterContent={
          entry.id === "appearance" && (
            <div className="border-edge-strong mt-8 border-t pt-8">
              <div className="mb-4">
                <h2 className="text-body text-xl font-semibold">Try it yourself</h2>
                <p className="ui-text-sm text-muted mt-1">
                  These are the real appearance settings from the app. Switch to the dark theme to
                  see the warm, low-blue-light palette, or adjust the fonts and text size &mdash;
                  changes apply live to this article. Your choices are saved in this browser.
                </p>
              </div>
              <AppearanceSettings />
            </div>
          )
        }
      />
    </ScrollContainer>
  );
}

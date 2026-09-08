/**
 * Demo-only content rendered inside specific articles (via EntryContentOptions):
 * the welcome article's sign-up call to action, and the live appearance settings
 * beneath the appearance article.
 */

"use client";

import { PageLink } from "@/components/ui/page-link";
import { AppearanceSettings } from "@/components/settings/AppearanceSettings";
import type { EntryContentSlots } from "@/components/entries/EntryContentOptions";

function WelcomeCallToAction() {
  return (
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
  );
}

function AppearanceTryIt() {
  return (
    <div className="border-edge-strong mt-8 border-t pt-8">
      <div className="mb-4">
        <h2 className="text-body text-xl font-semibold">Try it yourself</h2>
        <p className="ui-text-sm text-muted mt-1">
          These are the real appearance settings from the app. Switch to the dark theme to see the
          warm, low-blue-light palette, or adjust the fonts and text size &mdash; changes apply live
          to this article. Your choices are saved in this browser.
        </p>
      </div>
      <AppearanceSettings />
    </div>
  );
}

export function demoEntrySlots(entryId: string): EntryContentSlots | undefined {
  switch (entryId) {
    case "welcome":
      return { beforeContent: <WelcomeCallToAction /> };
    case "appearance":
      return { afterContent: <AppearanceTryIt /> };
    default:
      return undefined;
  }
}

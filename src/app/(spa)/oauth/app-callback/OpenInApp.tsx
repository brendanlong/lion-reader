"use client";

import { Button } from "@/components/ui/button";

/**
 * Hands this page's URL (the sign-in redirect) to the app through an `intent:`
 * link naming its package. A browser lands here when it didn't hand the
 * redirect over itself: Firefox, for one, won't after a same-site login, or
 * with "open links in apps" off. The tap is the user gesture browsers want
 * before opening an app; the sign-in's own state check turns away anything but
 * the redirect the app is waiting for. Built on click, so the code never ends
 * up in the markup.
 */
/** An `intent:` link that opens [href] in [packageName], whatever its link settings. */
export function appIntentUrl(href: string, packageName: string, action: string): string {
  const url = new URL(href);
  return (
    `intent://${url.host}${url.pathname}${url.search}#Intent;` +
    `scheme=${url.protocol.replace(":", "")};action=${action};` +
    `category=android.intent.category.BROWSABLE;package=${packageName};end`
  );
}

export function OpenInApp({
  packageName,
  action = "android.intent.action.VIEW",
  label,
}: {
  packageName: string;
  action?: string;
  label: string;
}) {
  function open() {
    window.location.href = appIntentUrl(window.location.href, packageName, action);
  }

  return (
    <Button className="mt-4 w-full" onClick={open}>
      {label}
    </Button>
  );
}

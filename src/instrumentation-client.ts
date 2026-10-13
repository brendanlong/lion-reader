/**
 * Client Instrumentation (Next.js convention, replaces sentry.client.config.ts)
 *
 * Runs in the browser before the app hydrates. This is where client-side
 * Sentry is started. Like src/instrumentation.ts, Next.js resolves this
 * file from `src/` first, then the repo root.
 *
 * The SDK loads once the page is idle (see `@/lib/sentry/client`), keeping it
 * out of the critical path. Until then, uncaught errors and unhandled
 * rejections are buffered and reported once it's initialized. Tracing
 * still measures the page load from navigation start, but requests and
 * interactions before the SDK loads aren't traced.
 *
 * https://nextjs.org/docs/app/guides/instrumentation-client
 * https://docs.sentry.io/platforms/javascript/guides/nextjs/
 */

import { bufferEarlyErrorsUntilLoaded, loadSentry } from "@/lib/sentry/client";

type SentrySdk = NonNullable<Awaited<ReturnType<typeof loadSentry>>>;

let sentry: SentrySdk | null = null;

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  bufferEarlyErrorsUntilLoaded();

  const start = () => {
    void loadSentry().then((loaded) => {
      sentry = loaded;
    });
  };
  const startWhenIdle = () => {
    if ("requestIdleCallback" in window) requestIdleCallback(start, { timeout: 5000 });
    else setTimeout(start, 0);
  };
  if (document.readyState === "complete") startWhenIdle();
  else window.addEventListener("load", startWhenIdle, { once: true });
  // Leaving before the page is idle: try to get buffered errors out anyway
  // (best effort; the page may be gone before they're sent).
  window.addEventListener("pagehide", start, { once: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") start();
  });
}

// Instruments Next.js router transitions for tracing. Most in-app navigation
// here bypasses the Next router (ClientLink uses pushState directly), so this
// mainly covers initial-load route changes (none before the SDK loads);
// exported to follow the convention.
export function onRouterTransitionStart(href: string, navigationType: string): void {
  sentry?.captureRouterTransitionStart(href, navigationType);
}

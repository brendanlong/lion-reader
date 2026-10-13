/**
 * Client Instrumentation (Next.js convention, replaces sentry.client.config.ts)
 *
 * Runs in the browser before the app hydrates. This is where client-side
 * Sentry is started. Like src/instrumentation.ts, Next.js resolves this
 * file from `src/` first, then the repo root.
 *
 * The SDK loads once the page is idle (see `@/lib/sentry/client`), keeping it
 * out of the critical path. Until then, uncaught errors and unhandled
 * rejections are buffered here and reported once it's initialized. Tracing
 * still measures the page load from navigation start, but requests and
 * interactions before the SDK loads aren't traced.
 *
 * https://nextjs.org/docs/app/guides/instrumentation-client
 * https://docs.sentry.io/platforms/javascript/guides/nextjs/
 */

import { loadSentry } from "@/lib/sentry/client";

type SentrySdk = NonNullable<Awaited<ReturnType<typeof loadSentry>>>;

let sentry: SentrySdk | null = null;

if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  const earlyErrors: unknown[] = [];
  const onError = (event: ErrorEvent) => {
    if (event.error !== undefined) earlyErrors.push(event.error);
  };
  const onRejection = (event: PromiseRejectionEvent) => earlyErrors.push(event.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  const start = () => {
    void loadSentry().then((loaded) => {
      // Sentry's own global handlers take over from here.
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      sentry = loaded;
      for (const error of earlyErrors.splice(0)) loaded?.captureException(error);
    });
  };
  const startWhenIdle = () => {
    if ("requestIdleCallback" in window) requestIdleCallback(start, { timeout: 5000 });
    else setTimeout(start, 0);
  };
  if (document.readyState === "complete") startWhenIdle();
  else window.addEventListener("load", startWhenIdle, { once: true });
}

// Instruments Next.js router transitions for tracing. Most in-app navigation
// here bypasses the Next router (ClientLink uses pushState directly), so this
// mainly covers initial-load route changes (none before the SDK loads);
// exported to follow the convention.
export function onRouterTransitionStart(href: string, navigationType: string): void {
  sentry?.captureRouterTransitionStart(href, navigationType);
}

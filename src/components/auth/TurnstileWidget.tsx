"use client";

import { useEffect, useRef, useState } from "react";
import { TURNSTILE_ORIGIN } from "@/lib/turnstile";

interface TurnstileRenderOptions {
  sitekey: string;
  theme: "auto";
  callback: (token: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
}

interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptLoad: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile didn't load"));
    script.onerror = () => {
      scriptLoad = null;
      reject(new Error("Turnstile didn't load"));
    };
    document.head.appendChild(script);
  });
  return scriptLoad;
}

/**
 * Cloudflare Turnstile's challenge. Reports each fresh token to `onToken` (keep
 * it stable, e.g. a state setter), and null once it expires or fails. A token
 * is single-use, so change `resetKey` after a submission to get a new one.
 */
export function TurnstileWidget({
  siteKey,
  onToken,
  resetKey,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
  resetKey: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<{ api: TurnstileApi; id: string } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled || !containerRef.current) return;
        const id = api.render(containerRef.current, {
          sitekey: siteKey,
          theme: "auto",
          callback: (token) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
        });
        widgetRef.current = { api, id };
      })
      .catch(() => setLoadFailed(true));
    return () => {
      cancelled = true;
      widgetRef.current?.api.remove(widgetRef.current.id);
      widgetRef.current = null;
    };
  }, [siteKey, onToken]);

  useEffect(() => {
    if (resetKey === 0 || !widgetRef.current) return;
    onToken(null);
    widgetRef.current.api.reset(widgetRef.current.id);
  }, [resetKey, onToken]);

  if (loadFailed) {
    return (
      <p className="ui-text-sm text-danger">
        The CAPTCHA didn&apos;t load. Reload the page, or check that nothing is blocking{" "}
        {new URL(TURNSTILE_ORIGIN).host}.
      </p>
    );
  }
  return <div ref={containerRef} className="flex min-h-[65px] justify-center" />;
}

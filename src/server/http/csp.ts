/**
 * Content-Security-Policy construction (issue #1275).
 *
 * The policy is built per-request in `src/proxy.ts` around a random nonce, so
 * `script-src` can be locked down while still allowing the app's own inline
 * scripts (the text-appearance and service-worker-registration scripts in
 * `src/app/layout.tsx`, plus next-themes' theme script). Entry bodies render
 * untrusted-but-sanitized HTML via `dangerouslySetInnerHTML`, so this CSP is
 * the backstop that turns a sanitizer regression from an XSS into a blocked
 * script — see SECURITY.md.
 *
 * The maintenance short-circuit in `scripts/server.ts` bypasses Next.js (and
 * therefore the proxy), so it carries its own static, script-less CSP — keep
 * the two conceptually in sync when changing directives here.
 */

import { embedCanonicalHostnames } from "@lion-reader/sanitizer";

/**
 * Builds the Content-Security-Policy header value for a request.
 *
 * Directive rationale:
 *
 * - `script-src`: the nonce + `'strict-dynamic'` is the modern CSP3 pattern —
 *   only nonce'd scripts run, and trust propagates to scripts they load
 *   (Next.js chunk loading, dynamic `import()` of the ONNX runtime). `'self'`
 *   is a fallback for pre-CSP3 browsers, which ignore `'strict-dynamic'`.
 *   `'wasm-unsafe-eval'` is required to compile WebAssembly (ONNX runtime and
 *   Piper phonemizer for TTS narration) but deliberately NOT `'unsafe-eval'`:
 *   runtime `eval`/`new Function` stays blocked. onnxruntime-web is pinned to
 *   its CPU-only `./wasm` build (a bundler alias in `next.config.ts`) precisely
 *   because the default WebGPU/WebNN "JSEP" build's Embind init calls
 *   `new Function`, which would trip this policy; do not "fix" a resulting CSP
 *   eval warning by adding `'unsafe-eval'`. Dev additionally needs
 *   `'unsafe-eval'` for React Refresh / HMR.
 * - `style-src 'unsafe-inline'`: inline styles are pervasive (React `style`
 *   props, next-themes, sonner, `NarrationHighlightStyles`, sanitized entry
 *   `style` attributes) and inline-style injection is far lower risk than
 *   script injection. Do NOT add a nonce or hash here — any nonce/hash in a
 *   directive makes browsers ignore its `'unsafe-inline'`.
 * - `img-src`/`media-src`: sanitized entry HTML allows `<img>`/`<audio>`/
 *   `<video>` with http/https/data URLs from arbitrary feeds (see
 *   `SANITIZE_OPTIONS.allowedSchemesByTag`), and TTS uses a `data:` silent
 *   audio unlock. `http:` also covers plain-HTTP local dev.
 * - `connect-src`: same-origin covers tRPC, SSE, and the Sentry `/monitoring`
 *   tunnel. The external hosts are the TTS narration downloads: Piper voice
 *   models from Hugging Face and the Piper phonemizer wasm/data from jsdelivr
 *   (`CUSTOM_WASM_PATHS` in `src/lib/narration/piper-tts-provider.ts`). CSP
 *   checks every hop of a redirect chain, and `huggingface.co/…/resolve/…`
 *   302s to its storage CDNs — `cdn-lfs*.huggingface.co` historically, Xet
 *   hosts like `cas-bridge.xethub.hf.co` today. A CSP host wildcard
 *   suffix-matches subdomains at ANY depth (unlike TLS certs), so
 *   `https://*.hf.co` covers the multi-label Xet hosts. Dev needs `ws:` for
 *   HMR.
 * - `worker-src`: the service worker is same-origin; the ONNX runtime spawns
 *   its threading helper workers from `blob:` URLs.
 * - `frame-src`: exactly the sanitizer's allow-listed embed providers — every
 *   iframe that survives sanitization is rewritten to one of these canonical
 *   hosts (`EMBED_CANONICAL_HOSTNAMES`), so the CSP double-enforces that list.
 * - `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`: the
 *   pre-existing baseline (plugins, `<base>` hijacking, clickjacking).
 * - The CDN origin (`ASSET_PREFIX`, the Next.js `assetPrefix` in
 *   `next.config.ts`): the hashed `/_next/static` assets — JS chunks, CSS, and
 *   next/font files — load from it in production, so it joins `script-src`
 *   (the `'self'` fallback path for pre-CSP3 browsers; `'strict-dynamic'`
 *   browsers ignore the host list), `style-src`, `font-src`, and `default-src`
 *   (which backstops `<link rel="prefetch">`). Unset in dev/tests, where the
 *   directives stay origin-only.
 * - `form-action` is deliberately absent: Chrome checks post-submit redirects
 *   against it, which would break the OAuth consent flow (form POST to self,
 *   then 302 to the client's external `redirect_uri`). Note `form-action`
 *   does NOT fall back to `default-src` — omitted means form submissions are
 *   unrestricted. That's acceptable here because the sanitizer strips
 *   `<form>` from entry HTML, so an injected exfiltration form can't reach
 *   the DOM in the first place.
 */
export function buildContentSecurityPolicy(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  // " https://lionreader.b-cdn.net" in production, "" when no CDN is configured.
  const assetPrefix = process.env.ASSET_PREFIX;
  const cdn = assetPrefix ? ` ${new URL(assetPrefix).origin}` : "";
  const frameSrc = embedCanonicalHostnames()
    .map((host) => `https://${host}`)
    .join(" ");
  return [
    `default-src 'self'${cdn}`,
    `script-src 'self'${cdn} 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${
      isDev ? " 'unsafe-eval'" : ""
    }`,
    `style-src 'self'${cdn} 'unsafe-inline'`,
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' data: blob: http: https:",
    `font-src 'self'${cdn} data:`,
    `connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co https://cdn.jsdelivr.net${
      isDev ? " ws:" : ""
    }`,
    "worker-src 'self' blob:",
    `frame-src ${frameSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * Generates the per-request CSP nonce: 128 bits of randomness, base64-encoded.
 * The header grammar (`base64-value`) accepts both standard base64 and
 * base64url characters, and the value round-trips verbatim between the header
 * and the `nonce` attributes.
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

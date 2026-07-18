import type { NextConfig } from "next";
import withPWA from "@ducanh2912/next-pwa";
import { withSentryConfig } from "@sentry/nextjs";

// PWA configuration - wraps the Next.js config to add the service worker.
//
// Precaching is deliberately DISABLED (see `exclude` / `publicExcludes` below).
// The service worker earns its keep only for the Share Target API (worker/index.ts
// handles POSTs to /api/share) and PWA installability — NOT for offline, which
// doesn't work anyway: navigations aren't intercepted and no HTML/data is cached,
// so a precached JS/asset shell is unreachable offline. Precaching every
// _next/static chunk and public asset therefore bought us only downsides: it
// duplicates the browser's own HTTP cache, forces a service-worker round-trip for
// assets the browser could serve from memory (the source of the image-paint
// flash, since public/demo images were precached), and — with skipWaiting +
// clientsClaim — lets a freshly-activated worker serve newer precached chunks to
// a tab still running older HTML. Letting everything fall through to the browser's
// native HTTP cache is simpler and faster; our static assets are already immutable
// + content-hashed (or CDN-served with long cache-control headers).
const withPWAConfig = withPWA({
  dest: "public",
  // Disable PWA in development for faster builds
  disable: process.env.NODE_ENV === "development",
  // Custom worker source for share target handling
  customWorkerSrc: "worker",
  // Don't cache or intercept the start URL ("/"): navigations are deliberately
  // never SW-intercepted (streaming SSR), and with no other caching an offline
  // start page is unreachable anyway. Both
  // flags are needed — `dynamicStartUrl` (default true) is what registers the
  // NetworkFirst "start-url" route in the generated SW (and the cache-put in
  // the registration script); `cacheStartUrl` would otherwise add "/" to the
  // precache manifest via additionalManifestEntries, which bypasses the
  // webpack-asset `exclude` filter below.
  cacheStartUrl: false,
  dynamicStartUrl: false,
  // Precache nothing from the public/ folder (icons, demo images, manifest, ...).
  // globby builds the public precache list as ["**/*", ...publicExcludes]; a
  // "!**/*" negation empties it. See workboxOptions.exclude for _next/static.
  publicExcludes: ["!**/*"],
  workboxOptions: {
    // Skip waiting to activate new service workers immediately
    skipWaiting: true,
    clientsClaim: true,
    // Precache nothing from the webpack build either: exclude every emitted
    // asset from the precache manifest so `precacheAndRoute` gets an empty list.
    // The custom worker still registers a fetch handler, so installability and
    // the Share Target handler are unaffected.
    exclude: [/.*/],
    // No runtime caching (specifying runtimeCaching also suppresses next-pwa's
    // large default list). The SW exists solely for the Share Target handler
    // (worker/index.ts) and PWA installability:
    // - Fonts are self-hosted by next/font at build time, so the Google Fonts
    //   routes previously listed here could never match a request.
    // - Images are deliberately not SW-cached: serving a remounted <img> via
    //   respondWith is always async, forfeiting the browser's synchronous
    //   memory/image-cache paint. (The alt-text flash this was blamed for was
    //   ultimately a Cache-Control bug — a `max-age=0` on images forced a
    //   network revalidation on every <img> remount — but SW-serving images
    //   would reintroduce the same async remount by another path.)
    // Everything falls through to the browser's HTTP cache + our headers() below.
    // Workbox's GenerateSW rejects a config with neither precache entries nor
    // runtime routes, so register one route that can never match.
    runtimeCaching: [{ urlPattern: () => false, handler: "NetworkOnly" }],
  },
});

// Security response headers applied to every route (defense-in-depth). Entry
// bodies render via `dangerouslySetInnerHTML`, so the server-side sanitizer is
// the primary XSS gate; these headers make a future sanitizer regression a
// non-event and stop the app from being framed (clickjacking).
//
// The Content-Security-Policy is NOT set here: it carries a per-request nonce
// for the inline <script>s in layout.tsx, which a static `headers()` value
// can't emit, so it is set in `src/proxy.ts` (policy in `src/server/http/csp.ts`).
// `X-Frame-Options` duplicates the CSP's `frame-ancestors 'none'` for browsers
// that predate it.
const securityHeaders: { key: string; value: string }[] = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // HSTS only in production: sending it over plaintext dev/HTTP would pin
  // localhost to HTTPS. Fly.io terminates TLS and serves everything over HTTPS.
  ...(process.env.NODE_ENV === "production"
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // The root layout is split into two route groups — (spa) dynamic and
  // (public) static (issue #1359) — so there is no single root layout for a
  // root not-found.tsx to render inside. global-not-found.tsx (a complete,
  // self-contained document) handles unmatched URLs instead; this flag enables
  // that file convention.
  experimental: {
    globalNotFound: true,
  },
  // Serve the hashed /_next/static assets from the CDN (a Bunny pull zone with
  // the app as origin). Set via env so dev and CI builds (which run against
  // local servers the pull zone can't reach) stay origin-served; the production
  // Dockerfile defaults it to https://lionreader.b-cdn.net. The CDN origin is
  // also added to the CSP (src/server/http/csp.ts) from the same env var.
  // Assets are content-hashed and served with `immutable`, so the pull zone
  // needs no purging or deploy coordination. Files in public/ are not affected
  // (they stay origin-served).
  assetPrefix: process.env.ASSET_PREFIX || undefined,
  // Emit .next/standalone with a traced, minimal node_modules — the production
  // image ships that instead of the full pruned node_modules (issue #1305).
  // Our custom server (dist/server.js) keeps `next` external and resolves it
  // from the standalone node_modules at runtime; deps only needed by the
  // worker/discord bundles are bundled by esbuild, and their few runtime
  // externals (argon2, html-rewriter-wasm, @lion-reader/*) are all also in the
  // Next server graph, so the trace covers them.
  output: "standalone",
  // Disable Next.js's built-in gzip compression. Our custom server applies
  // zstd/brotli/gzip/deflate compression to streaming SSR responses, and
  // Fly.io's edge handles non-streaming responses.
  compress: false,
  // Serve the demo article URLs (`?entry=` on any /demo page) from the
  // statically-prerendered /demo/entry/[entryId] route (issue #1359). Reading
  // `searchParams` in a server component forces per-request rendering, so the
  // demo pages themselves never look at the query — this server-internal
  // rewrite (the browser URL is unchanged) picks the article page instead.
  // DemoRouter re-derives the view client-side from the real URL after
  // hydration, exactly as before. An `entry` value that doesn't match the id
  // charset falls through to the (static) list page, which ignores the query —
  // the same treatment such values got from the old `?entry=` lookup.
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/demo/:path*",
          has: [{ type: "query", key: "entry", value: "(?<entry>[A-Za-z0-9_-]+)" }],
          destination: "/demo/entry/:entry",
        },
      ],
    };
  },
  // Cache static assets for 1 day to reduce unnecessary requests
  async headers() {
    return [
      {
        // Security headers on every response (defense-in-depth).
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        // Non-hashed public/ assets (favicon/icons, emojis, svgs,
        // social-preview.png): a moderate TTL so an update propagates without a
        // filename hash. Deliberately NOT immutable for that reason. This glob
        // also matches image/font extensions under /_next/static/media; the
        // immutable rule below runs after it and wins there (last match wins).
        source: "/:path*.(ico|png|svg|jpg|jpeg|gif|webp|woff|woff2|ttf|otf|eot)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
      {
        // Everything under /_next/static is content-hashed (JS/CSS chunks,
        // next/font files, and imported images like the demo heroes), so it can
        // be cached forever. Next sets this itself, but the public/ rule above
        // would otherwise downgrade fonts and imported images (png/woff2) to the
        // 1-day TTL — this reinstates `immutable`. Cache-key safety comes from
        // the filename hash, so the CDN needs no `?v=` query-string config.
        source: "/_next/static/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        // Service worker must be served with no-cache to ensure updates
        source: "/sw.js",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=0, must-revalidate",
          },
          {
            // Allow service worker to control the entire origin
            key: "Service-Worker-Allowed",
            value: "/",
          },
        ],
      },
    ];
  },
  // Packages that should be loaded from node_modules at runtime, not bundled
  // - html-rewriter-wasm contains a WASM file that can't be bundled by Next.js
  // - trpc-to-openapi must not be bundled: webpack tree-shakes zod's `coerce`
  //   export (only referenced via `'coerce' in z`), which flips the library's
  //   `zodSupportsCoerce` check to false and makes it reject numeric query
  //   params (e.g. `limit`) when generating the OpenAPI document.
  serverExternalPackages: [
    "html-rewriter-wasm",
    "trpc-to-openapi",
    "@lion-reader/sanitizer",
    "@lion-reader/readability",
    "@lion-reader/feed-parser",
  ],
  // Handle piper-tts-web which has conditional Node.js code (require('fs'))
  // that the bundler tries to resolve even though it only runs in Node.js
  webpack: (config, { isServer, nextRuntime }) => {
    if (!isServer) {
      // Stub out Node.js modules for client bundles
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
      // Redirect onnxruntime-web (pulled in only by piper-tts-web for TTS
      // narration) to its CPU-only `./wasm` build. The default entry loads the
      // WebGPU/WebNN "JSEP" glue, which calls `new Function(...)` in its
      // Emscripten/Embind init — both in the bundled `ort.bundle.min.mjs` and
      // in the runtime-fetched `ort-wasm-simd-threaded.jsep.mjs` from
      // public/onnx/. CSP treats `new Function` as `eval` and blocks it in prod
      // (script-src has `wasm-unsafe-eval` but deliberately not `unsafe-eval`).
      // Piper runs pure CPU inference and requests no `executionProviders`, so
      // the JSEP build is dead weight whose init trips a CSP violation. The
      // `$` limits the alias to the bare specifier so runtime wasm-file loads
      // (served from public/onnx/) are untouched. See src/server/http/csp.ts.
      config.resolve.alias = {
        ...config.resolve.alias,
        "onnxruntime-web$": "onnxruntime-web/wasm",
      };
    }
    // isomorphic-dompurify pulls in jsdom during SSR of `"use client"` components
    // (e.g. EntryContentBody). jsdom reads browser/default-stylesheet.css via
    // `path.resolve(__dirname, ...)` at runtime; bundling breaks __dirname so the
    // read resolves to a bogus path (e.g. /app/browser/default-stylesheet.css) and
    // throws ENOENT mid-stream, producing a 500 status even though the shell already
    // rendered. `serverExternalPackages` doesn't cover deps reached through the
    // client-component SSR graph, so force-externalize jsdom on the Node server build
    // to load it from node_modules where the __dirname-relative read resolves.
    if (isServer && nextRuntime === "nodejs") {
      // Bare string (not { jsdom: "commonjs jsdom" }) so webpack emits the external
      // in whatever module format the server build uses, staying correct if Next
      // ever switches the Node server output to ESM.
      config.externals.push("jsdom");
    }
    // Silence known-benign "Critical dependency" warnings from Sentry's Node SDK.
    // @sentry/node pulls in OpenTelemetry auto-instrumentation, which uses
    // require-in-the-middle / @prisma/instrumentation to hook module loads via
    // dynamic require(). webpack can't statically resolve those, so it emits a
    // "Critical dependency" warning (with a long import trace) for each otel
    // instrumentation version — dozens of lines of build noise for third-party
    // code we can't change. Scope the ignore to those packages so warnings from
    // our own code still surface.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      {
        module: /@opentelemetry\/instrumentation/,
        message: /Critical dependency: the request of a dependency is an expression/,
      },
      {
        module: /require-in-the-middle/,
        message:
          /Critical dependency: require function is used in a way in which dependencies cannot be statically extracted/,
      },
      {
        module: /@prisma\/instrumentation/,
        message: /Critical dependency: the request of a dependency is an expression/,
      },
    ];
    config.devtool = "source-map";
    return config;
  },
  // Turbopack equivalent configuration
  turbopack: {
    resolveAlias: {
      fs: { browser: "./src/lib/stubs/empty.js" },
      path: { browser: "./src/lib/stubs/empty.js" },
      // See the webpack `onnxruntime-web$` alias above: use the CPU-only build
      // so the JSEP glue's `new Function` (CSP eval) never loads.
      "onnxruntime-web": { browser: "onnxruntime-web/wasm" },
    },
  },
};

// Sentry webpack plugin options
// https://github.com/getsentry/sentry-webpack-plugin#options
const sentryWebpackPluginOptions = {
  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Only upload source maps in production builds when SENTRY_AUTH_TOKEN is available
  silent: !process.env.CI,

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers
  tunnelRoute: "/monitoring",

  // Hides source maps from generated client bundles
  hideSourceMaps: true,

  // Automatically tree-shake Sentry logger statements to reduce bundle size
  disableLogger: true,
};

// Wrap with PWA first, then Sentry if configured
const pwaConfig = withPWAConfig(nextConfig);

// Only wrap with Sentry if DSN is configured
const exportedConfig = process.env.SENTRY_DSN
  ? withSentryConfig(pwaConfig, sentryWebpackPluginOptions)
  : pwaConfig;

export default exportedConfig;

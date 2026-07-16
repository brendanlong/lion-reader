import { execSync } from "child_process";
import type { NextConfig } from "next";
import withPWA from "@ducanh2912/next-pwa";
import { withSentryConfig } from "@sentry/nextjs";

// Get git commit SHA at build time
function getGitCommitSha(): string | undefined {
  // First check environment variable (set by CI/CD systems like Vercel, Fly.io)
  if (process.env.GIT_COMMIT_SHA) {
    return process.env.GIT_COMMIT_SHA;
  }
  // Fall back to git command
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return undefined;
  }
}

// PWA configuration - wraps the Next.js config to enable service worker precaching
const withPWAConfig = withPWA({
  dest: "public",
  // Disable PWA in development for faster builds
  disable: process.env.NODE_ENV === "development",
  // Custom worker source for share target handling
  customWorkerSrc: "worker",
  // Workbox configuration for caching strategies
  workboxOptions: {
    // Skip waiting to activate new service workers immediately
    skipWaiting: true,
    clientsClaim: true,
    // Runtime caching configuration for Next.js static assets
    // Note: next-pwa automatically precaches _next/static/* during build
    runtimeCaching: [
      // Cache Google Fonts stylesheets
      {
        urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
        handler: "StaleWhileRevalidate",
        options: {
          cacheName: "google-fonts-stylesheets",
          expiration: {
            maxEntries: 10,
            maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
          },
        },
      },
      // Cache Google Fonts webfont files
      {
        urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
        handler: "CacheFirst",
        options: {
          cacheName: "google-fonts-webfonts",
          expiration: {
            maxEntries: 20,
            maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
          },
          cacheableResponse: {
            statuses: [0, 200],
          },
        },
      },
      // Cache images with stale-while-revalidate
      {
        urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp|ico)$/i,
        handler: "StaleWhileRevalidate",
        options: {
          cacheName: "static-images",
          expiration: {
            maxEntries: 100,
            maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
          },
        },
      },
    ],
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
  // Disable Next.js's built-in gzip compression. Our custom server applies
  // zstd/brotli/gzip/deflate compression to streaming SSR responses, and
  // Fly.io's edge handles non-streaming responses.
  compress: false,
  env: {
    // Inject git commit SHA at build time
    GIT_COMMIT_SHA: getGitCommitSha(),
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
        // Match common static assets in public/
        source: "/:path*.(ico|png|svg|jpg|jpeg|gif|webp|woff|woff2|ttf|otf|eot)",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
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
  serverExternalPackages: ["html-rewriter-wasm", "piscina", "trpc-to-openapi"],
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

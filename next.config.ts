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

const nextConfig: NextConfig = {
  env: {
    // Inject git commit SHA at build time
    GIT_COMMIT_SHA: getGitCommitSha(),
  },
  // Rewrite FreshRSS-style Google Reader API paths to our standard paths.
  // Many Android clients (FocusReader, SmartRSS, etc.) configured as "FreshRSS"
  // prepend /api/greader.php to all Google Reader API paths.
  async rewrites() {
    return [
      {
        source: "/api/greader.php/accounts/:path*",
        destination: "/accounts/:path*",
      },
      {
        source: "/api/greader.php/reader/:path*",
        destination: "/reader/:path*",
      },
    ];
  },
  // Cache static assets for 1 day to reduce unnecessary requests
  async headers() {
    return [
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
  // html-rewriter-wasm contains a WASM file that can't be bundled by Next.js
  serverExternalPackages: ["html-rewriter-wasm"],
  // Handle piper-tts-web which has conditional Node.js code (require('fs'))
  // that the bundler tries to resolve even though it only runs in Node.js
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Stub out Node.js modules for client bundles
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      };
    }
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

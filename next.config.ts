import { execSync } from "child_process";
import type { NextConfig } from "next";
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

const nextConfig: NextConfig = {
  env: {
    // Inject git commit SHA at build time
    GIT_COMMIT_SHA: getGitCommitSha(),
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

// Only wrap with Sentry if DSN is configured
const exportedConfig = process.env.SENTRY_DSN
  ? withSentryConfig(nextConfig, sentryWebpackPluginOptions)
  : nextConfig;

export default exportedConfig;

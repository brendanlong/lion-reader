/**
 * Plugin system for Lion Reader
 *
 * Consolidates custom parsing logic for feeds, entries, and saved articles.
 * Plugins are registered at module load time and provide capabilities for different use cases.
 */

import { pluginRegistry } from "./registry";
import { lessWrongPlugin } from "./lesswrong";
import { googleDocsPlugin } from "./google-docs";
import { arxivPlugin } from "./arxiv";
import { githubPlugin } from "./github";
import { logger } from "@/lib/logger";

// Register all available plugins at module load time
pluginRegistry.register(lessWrongPlugin);
pluginRegistry.register(googleDocsPlugin);
pluginRegistry.register(arxivPlugin);
pluginRegistry.register(githubPlugin);

logger.info("Plugins registered", {
  plugins: [lessWrongPlugin.name, googleDocsPlugin.name, arxivPlugin.name, githubPlugin.name],
});

/**
 * Resolve the feed-capable plugin for a feed or page URL string.
 *
 * Returns the matching plugin (with its `feed` capability) or null if the URL is
 * invalid or no plugin handles it. Use this at feed-processing call sites so
 * feed-source customization lives in plugins rather than hardcoded branches.
 */
export function getFeedPlugin(url: string | URL | null | undefined) {
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return null;
  }

  return pluginRegistry.findWithCapability(parsed, "feed");
}

// Export registry and types
export { pluginRegistry } from "./registry";
export type * from "./types";

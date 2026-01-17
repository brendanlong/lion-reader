/**
 * Plugin system for Lion Reader
 *
 * Consolidates custom parsing logic for feeds, entries, and saved articles.
 * Plugins are registered at startup and provide capabilities for different use cases.
 */

import { pluginRegistry } from "./registry";
import { lessWrongPlugin } from "./lesswrong";
import { googleDocsPlugin } from "./google-docs";
import { arxivPlugin } from "./arxiv";
import { logger } from "@/lib/logger";

/**
 * Register all available plugins at startup.
 *
 * This function should be called once when the server starts.
 */
export function registerPlugins() {
  pluginRegistry.register(lessWrongPlugin);
  pluginRegistry.register(googleDocsPlugin);
  pluginRegistry.register(arxivPlugin);
  logger.info("Plugins registered", {
    plugins: [lessWrongPlugin.name, googleDocsPlugin.name, arxivPlugin.name],
  });
}

// Export registry and types
export { pluginRegistry } from "./registry";
export type * from "./types";

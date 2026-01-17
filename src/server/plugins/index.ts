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

// Export registry and types
export { pluginRegistry } from "./registry";
export type * from "./types";

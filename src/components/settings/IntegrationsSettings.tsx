/**
 * IntegrationsSettings Component
 *
 * Settings section for AI assistant integrations via MCP (Model Context Protocol).
 * Shows setup instructions for Claude Desktop, Claude Code, and claude.ai.
 */

"use client";

import { useMemo } from "react";
import { Alert } from "@/components/ui/alert";
import { CodeBlock, CopyButton } from "@/components/ui/copy-button";

export function IntegrationsSettings() {
  // Check env var first (available on both server and client), then fall back to window.location.origin
  const baseUrl = useMemo(() => {
    return (
      process.env.NEXT_PUBLIC_APP_URL ||
      (typeof window !== "undefined" ? window.location.origin : "")
    );
  }, []);

  const mcpUrl = `${baseUrl}/api/mcp`;

  const claudeDesktopConfig = useMemo(() => {
    return JSON.stringify(
      {
        mcpServers: {
          "lion-reader": {
            command: "npx",
            args: ["-y", "mcp-remote", mcpUrl],
          },
        },
      },
      null,
      2
    );
  }, [mcpUrl]);

  const claudeCodeCommand = `claude mcp add --transport http lionreader ${mcpUrl}`;

  return (
    <section>
      <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">
        AI Integrations
      </h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        {/* Description */}
        <p className="ui-text-sm text-zinc-600 dark:text-zinc-400">
          Connect Lion Reader to AI assistants via{" "}
          <a
            href="https://modelcontextprotocol.io/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:text-accent-hover font-medium"
          >
            MCP (Model Context Protocol)
          </a>
          . This lets Claude read, search, and manage your feeds directly.
        </p>

        {/* Claude Code */}
        <div className="mt-6">
          <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-100">Claude Code</h3>
          <p className="ui-text-sm mt-1 text-zinc-600 dark:text-zinc-400">
            Run this command in your terminal:
          </p>
          <CodeBlock code={claudeCodeCommand} className="mt-3" />
        </div>

        {/* Claude.ai */}
        <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
          <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-100">Claude.ai</h3>
          <div className="mt-2">
            <Alert variant="warning">
              The claude.ai <strong>web</strong> connector is currently broken due to a bug on
              claude.ai&rsquo;s side. See{" "}
              <a
                href="https://github.com/brendanlong/lion-reader/issues/986"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium underline"
              >
                this issue
              </a>
              . The MCP server should work with other tools, including Claude Code.
            </Alert>
          </div>
          <ol className="ui-text-sm mt-2 list-inside list-decimal space-y-2 text-zinc-600 dark:text-zinc-400">
            <li>Click your name in the bottom-left corner</li>
            <li>
              Go to <strong className="text-zinc-900 dark:text-zinc-200">Settings</strong> &rarr;{" "}
              <strong className="text-zinc-900 dark:text-zinc-200">Connectors</strong>
            </li>
            <li>
              Click{" "}
              <strong className="text-zinc-900 dark:text-zinc-200">Add Custom Connector</strong>
            </li>
            <li>
              Enter Name: <strong className="text-zinc-900 dark:text-zinc-200">Lion Reader</strong>
            </li>
            <li>
              Enter Remote MCP server URL:{" "}
              <code className="ui-text-xs rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
                {mcpUrl}
              </code>
              <CopyButton
                value={mcpUrl}
                className="ml-2 px-1.5 py-0.5"
                title="Copy MCP server URL"
              />
            </li>
          </ol>
        </div>

        {/* Claude Desktop */}
        <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
          <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Claude Desktop
          </h3>
          <p className="ui-text-sm mt-1 text-zinc-600 dark:text-zinc-400">
            Add this to your{" "}
            <code className="ui-text-xs rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
              claude_desktop_config.json
            </code>
            :
          </p>
          <CodeBlock code={claudeDesktopConfig} className="mt-3" />
        </div>

        {/* Note about MCP URL */}
        {baseUrl && (
          <p className="ui-text-xs mt-4 text-zinc-400 dark:text-zinc-500">
            MCP server URL: {mcpUrl}
          </p>
        )}
      </div>
    </section>
  );
}

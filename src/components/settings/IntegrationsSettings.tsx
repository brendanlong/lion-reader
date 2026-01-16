/**
 * IntegrationsSettings Component
 *
 * Settings section for AI assistant integrations via MCP (Model Context Protocol).
 * Shows setup instructions for Claude Desktop, Claude Code, and claude.ai.
 */

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

export function IntegrationsSettings() {
  const [copiedSection, setCopiedSection] = useState<string | null>(null);

  const baseUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return process.env.NEXT_PUBLIC_APP_URL || window.location.origin;
  }, []);

  const mcpUrl = `${baseUrl}/mcp`;

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

  const copyToClipboard = (text: string, section: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSection(section);
    setTimeout(() => setCopiedSection(null), 2000);
  };

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
        AI Integrations
      </h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        {/* Description */}
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Connect Lion Reader to AI assistants via{" "}
          <a
            href="https://modelcontextprotocol.io/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            MCP (Model Context Protocol)
          </a>
          . This lets Claude read, search, and manage your feeds directly.
        </p>

        {/* Claude Code */}
        <div className="mt-6">
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Claude Code</h3>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Run this command in your terminal:
          </p>
          <div className="relative mt-3">
            <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-100 p-3 pr-20 font-mono text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
              <code>{claudeCodeCommand}</code>
            </pre>
            <button
              type="button"
              onClick={() => copyToClipboard(claudeCodeCommand, "claude-code")}
              className="absolute top-2 right-2 rounded border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600 dark:hover:text-zinc-100"
            >
              {copiedSection === "claude-code" ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>

        {/* Claude.ai */}
        <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Claude.ai</h3>
          <ol className="mt-2 list-inside list-decimal space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
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
              <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">
                {mcpUrl}
              </code>
              <button
                type="button"
                onClick={() => copyToClipboard(mcpUrl, "claude-ai-url")}
                className="ml-2 rounded border border-zinc-300 bg-white px-1.5 py-0.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600 dark:hover:text-zinc-100"
              >
                {copiedSection === "claude-ai-url" ? "Copied!" : "Copy"}
              </button>
            </li>
          </ol>
        </div>

        {/* Claude Desktop */}
        <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
          <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Claude Desktop</h3>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Add this to your{" "}
            <code className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">
              claude_desktop_config.json
            </code>
            :
          </p>
          <div className="relative mt-3">
            <pre className="overflow-x-auto rounded-md border border-zinc-200 bg-zinc-100 p-3 pr-20 font-mono text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
              <code>{claudeDesktopConfig}</code>
            </pre>
            <button
              type="button"
              onClick={() => copyToClipboard(claudeDesktopConfig, "claude-desktop")}
              className="absolute top-2 right-2 rounded border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-600 dark:hover:text-zinc-100"
            >
              {copiedSection === "claude-desktop" ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>

        {/* API Tokens Link */}
        <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Need to manage API tokens or create custom integrations?
          </p>
          <Link
            href="/settings/api-tokens"
            className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            Manage API Tokens
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        </div>

        {/* Note about MCP URL */}
        {baseUrl && (
          <p className="mt-4 text-xs text-zinc-400 dark:text-zinc-500">MCP server URL: {mcpUrl}</p>
        )}
      </div>
    </section>
  );
}

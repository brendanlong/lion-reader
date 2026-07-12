/**
 * IntegrationsSettings Component
 *
 * Settings section for AI assistant integrations via MCP (Model Context Protocol).
 * Shows setup instructions for Claude Desktop, Claude Code, and claude.ai.
 */

"use client";

import { useMemo } from "react";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { Alert } from "@/components/ui/alert";
import { CardSection } from "@/components/ui/card";
import { CodeBlock, CopyButton } from "@/components/ui/copy-button";
import { InlineCode } from "@/components/ui/inline-code";
import { TextLink } from "@/components/ui/text-link";

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
    <SettingsSection
      title="AI Integrations"
      description={
        <>
          Connect Lion Reader to AI assistants via{" "}
          <TextLink href="https://modelcontextprotocol.io/" external>
            MCP (Model Context Protocol)
          </TextLink>
          . This lets Claude read, search, and manage your feeds directly.
        </>
      }
    >
      {/* Claude Code */}
      <div className="mt-6">
        <h3 className="ui-text-sm text-strong font-medium">Claude Code</h3>
        <p className="ui-text-sm text-muted mt-1">Run this command in your terminal:</p>
        <CodeBlock code={claudeCodeCommand} className="mt-3" />
      </div>

      {/* Claude.ai */}
      <CardSection>
        <h3 className="ui-text-sm text-strong font-medium">Claude.ai</h3>
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
        <ol className="ui-text-sm text-muted mt-2 list-inside list-decimal space-y-2">
          <li>Click your name in the bottom-left corner</li>
          <li>
            Go to <strong className="text-emphasis">Settings</strong> &rarr;{" "}
            <strong className="text-emphasis">Connectors</strong>
          </li>
          <li>
            Click <strong className="text-emphasis">Add Custom Connector</strong>
          </li>
          <li>
            Enter Name: <strong className="text-emphasis">Lion Reader</strong>
          </li>
          <li>
            Enter Remote MCP server URL: <InlineCode>{mcpUrl}</InlineCode>
            <CopyButton value={mcpUrl} className="ml-2 px-1.5 py-0.5" title="Copy MCP server URL" />
          </li>
        </ol>
      </CardSection>

      {/* Claude Desktop */}
      <CardSection>
        <h3 className="ui-text-sm text-strong font-medium">Claude Desktop</h3>
        <p className="ui-text-sm text-muted mt-1">
          Add this to your <InlineCode>claude_desktop_config.json</InlineCode>:
        </p>
        <CodeBlock code={claudeDesktopConfig} className="mt-3" />
      </CardSection>

      {/* Note about MCP URL */}
      {baseUrl && <p className="ui-text-xs text-faint mt-4">MCP server URL: {mcpUrl}</p>}
    </SettingsSection>
  );
}

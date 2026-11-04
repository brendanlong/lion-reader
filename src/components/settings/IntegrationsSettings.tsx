/**
 * IntegrationsSettings Component
 *
 * Settings section for AI assistant integrations via MCP (Model Context Protocol).
 */

"use client";

import { useAppBaseUrl } from "@/lib/hooks/useAppBaseUrl";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { CardSection } from "@/components/ui/card";
import { CodeBlock, CopyButton } from "@/components/ui/copy-button";
import { InlineCode } from "@/components/ui/inline-code";
import { TextLink } from "@/components/ui/text-link";
import mcpRegistryListing from "../../../server.json";

// Self-hosted instances aren't listed, so only the listed server gets the directory link.
const LISTED_MCP_URL = mcpRegistryListing.remotes[0].url;
const CLAUDE_DIRECTORY_URL = "https://claude.ai/directory/lion-reader";

export function IntegrationsSettings() {
  const baseUrl = useAppBaseUrl();

  const mcpUrl = `${baseUrl}/api/mcp`;
  const claudeCodeCommand = `claude mcp add --transport http lionreader ${mcpUrl}`;

  return (
    <SettingsSection
      id="ai-integrations"
      title="AI Integrations"
      description={
        <>
          Let Claude and other AI assistants read, search, and manage your feeds over{" "}
          <TextLink href="https://modelcontextprotocol.io/" external>
            MCP
          </TextLink>
          .
        </>
      }
    >
      {mcpUrl === LISTED_MCP_URL && (
        <CardSection>
          <h3 className="ui-text-sm text-body font-medium">Claude</h3>
          <p className="ui-text-sm text-muted mt-1">
            Connect{" "}
            <TextLink href={CLAUDE_DIRECTORY_URL} external>
              Lion Reader from the Claude directory
            </TextLink>{" "}
            and sign in. It works in Claude on the web, desktop, and mobile.
          </p>
        </CardSection>
      )}

      <CardSection>
        <h3 className="ui-text-sm text-body font-medium">Claude Code</h3>
        <p className="ui-text-sm text-muted mt-1">Run this in your terminal:</p>
        <CodeBlock code={claudeCodeCommand} className="mt-3" />
      </CardSection>

      {baseUrl && (
        <CardSection>
          <h3 className="ui-text-sm text-body font-medium">Server URL</h3>
          <p className="ui-text-sm text-muted mt-1">
            Add this as a remote MCP server in any other client, and sign in when asked:
          </p>
          <p className="ui-text-sm text-muted mt-3">
            <InlineCode>{mcpUrl}</InlineCode>
            <CopyButton value={mcpUrl} className="ml-2 px-1.5 py-0.5" title="Copy MCP server URL" />
          </p>
        </CardSection>
      )}
    </SettingsSection>
  );
}

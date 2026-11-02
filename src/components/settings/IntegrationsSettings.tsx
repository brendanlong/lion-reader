/**
 * IntegrationsSettings Component
 *
 * Settings section for AI assistant integrations via MCP (Model Context Protocol).
 * Shows setup instructions for Claude Desktop, Claude Code, and claude.ai.
 */

"use client";

import { useMemo, useState } from "react";
import { useAppBaseUrl } from "@/lib/hooks/useAppBaseUrl";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardSection } from "@/components/ui/card";
import { CodeBlock, CopyButton } from "@/components/ui/copy-button";
import { InlineCode } from "@/components/ui/inline-code";
import { TextLink } from "@/components/ui/text-link";

export function IntegrationsSettings() {
  const baseUrl = useAppBaseUrl();

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

  // claude.ai's connector OAuth is broken client-side (issue #986), so the
  // supported path is an MCP-scoped API token in an explicit header. Created
  // inline here so the instructions and the token are in one place; the token
  // is only ever shown once (it's stored hashed).
  const [claudeAiToken, setClaudeAiToken] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const createTokenMutation = trpc.apiTokens.create.useMutation({
    onSuccess: (data) => {
      setClaudeAiToken(data.token);
      // Keep the API Tokens settings page's list in sync.
      utils.apiTokens.list.invalidate();
      toast.success("MCP token created");
    },
    onError: (error) => {
      toast.error("Failed to create token", { description: error.message });
    },
  });

  return (
    <SettingsSection
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
      {baseUrl && (
        <p className="ui-text-sm text-muted">
          <strong className="text-body">MCP server URL:</strong> <InlineCode>{mcpUrl}</InlineCode>
          <CopyButton value={mcpUrl} className="ml-2 px-1.5 py-0.5" title="Copy MCP server URL" />
        </p>
      )}

      {/* Claude Code */}
      <CardSection>
        <h3 className="ui-text-sm text-body font-medium">Claude Code</h3>
        <p className="ui-text-sm text-muted mt-1">Run this in your terminal:</p>
        <CodeBlock code={claudeCodeCommand} className="mt-3" />
      </CardSection>

      {/* Claude.ai */}
      <CardSection>
        <h3 className="ui-text-sm text-body font-medium">Claude.ai</h3>
        <p className="ui-text-sm text-muted mt-1">
          Claude.ai&rsquo;s connector sign-in is{" "}
          <TextLink href="https://github.com/brendanlong/lion-reader/issues/986" external>
            broken on their side
          </TextLink>
          , so connect with a token instead:
        </p>
        <div className="mt-3">
          {claudeAiToken === null ? (
            <Button
              onClick={() => createTokenMutation.mutate({ name: "claude.ai", scopes: ["mcp"] })}
              disabled={createTokenMutation.isPending}
            >
              {createTokenMutation.isPending ? "Creating…" : "Create MCP token"}
            </Button>
          ) : (
            <div>
              <Alert variant="warning">
                Copy this now: it&apos;s only shown once. You can revoke it under{" "}
                <strong>Settings &rarr; Security</strong>.
              </Alert>
              <CodeBlock code={`Bearer ${claudeAiToken}`} className="mt-2" />
            </div>
          )}
        </div>
        <ol className="ui-text-sm text-muted mt-4 list-inside list-decimal space-y-2">
          <li>
            In claude.ai, go to <strong className="text-body">Settings</strong> &rarr;{" "}
            <strong className="text-body">Connectors</strong> &rarr;{" "}
            <strong className="text-body">Add custom connector</strong>
          </li>
          <li>
            Name: <strong className="text-body">Lion Reader</strong>
          </li>
          <li>Remote MCP server URL: the URL above</li>
          <li>
            Authentication: <strong className="text-body">None</strong>
          </li>
          <li>
            Under <strong className="text-body">Additional request headers</strong>, add a header
            named <InlineCode>Authorization</InlineCode> with the{" "}
            <InlineCode>Bearer &hellip;</InlineCode> value from above
          </li>
        </ol>
      </CardSection>

      {/* Claude Desktop */}
      <CardSection>
        <h3 className="ui-text-sm text-body font-medium">Claude Desktop</h3>
        <p className="ui-text-sm text-muted mt-1">
          Add this to your <InlineCode>claude_desktop_config.json</InlineCode>:
        </p>
        <CodeBlock code={claudeDesktopConfig} className="mt-3" />
      </CardSection>
    </SettingsSection>
  );
}

/**
 * DiscordBotSettings Component
 *
 * Settings section for the Discord bot integration.
 * Shows the bot invite link and usage instructions.
 */

"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { SettingsSection } from "@/components/settings/SettingsSection";
import { CardSection } from "@/components/ui/card";
import { NoteBox } from "@/components/ui/note-box";
import { InlineCode } from "@/components/ui/inline-code";
import { DiscordIcon, ExternalLinkIcon } from "@/components/ui/icon-button";

/**
 * Check if a string is a custom Discord emoji name (word) vs a unicode emoji.
 * Custom emojis are alphanumeric with underscores, like "savetolionreader".
 */
function isCustomEmoji(emoji: string): boolean {
  return /^[a-zA-Z0-9_]+$/.test(emoji);
}

/**
 * Format an emoji for display. Custom emojis get wrapped in colons.
 */
function formatEmoji(emoji: string): { text: string; isCustom: boolean } {
  const isCustom = isCustomEmoji(emoji);
  return {
    text: isCustom ? `:${emoji}:` : emoji,
    isCustom,
  };
}

export function DiscordBotSettings() {
  const [copied, setCopied] = useState(false);

  const { data: botConfig, isLoading } = trpc.auth.discordBotConfig.useQuery();

  const copyInviteUrl = () => {
    if (botConfig?.inviteUrl) {
      navigator.clipboard.writeText(botConfig.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Don't render if bot is not enabled
  if (isLoading) {
    return null;
  }

  if (!botConfig?.enabled) {
    return null;
  }

  const emoji = botConfig.saveEmoji ? formatEmoji(botConfig.saveEmoji) : null;
  const successEmoji = botConfig.successEmoji ? formatEmoji(botConfig.successEmoji) : null;
  const errorEmoji = botConfig.errorEmoji ? formatEmoji(botConfig.errorEmoji) : null;

  return (
    <SettingsSection
      title="Discord Bot"
      description="Save articles to Lion Reader by reacting to Discord messages, or by sending a link to the bot in a DM. When you react to (or DM the bot) a message containing a URL, the article will be saved to your account."
    >
      {/* Invite Button */}
      <div className="mt-6">
        <h3 className="ui-text-sm text-body font-medium">Add Bot to Server</h3>
        <p className="ui-text-sm text-muted mt-1">
          Invite the Lion Reader bot to your Discord server to enable saving articles.
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          <a
            href={botConfig.inviteUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="ui-text-sm inline-flex items-center gap-2 rounded-lg border border-indigo-300 bg-indigo-50 px-4 py-2.5 font-medium text-indigo-800 shadow-sm transition-all hover:border-indigo-400 hover:bg-indigo-100 hover:shadow dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-200 dark:hover:border-indigo-600 dark:hover:bg-indigo-900"
          >
            <DiscordIcon className="h-4 w-4" />
            Invite Bot
            <ExternalLinkIcon className="h-3.5 w-3.5" />
          </a>
          <button
            type="button"
            onClick={copyInviteUrl}
            className="ui-text-sm text-body border-edge-input inline-flex items-center gap-2 rounded-lg border bg-white px-4 py-2.5 font-medium shadow-sm transition-all hover:border-zinc-400 hover:bg-zinc-50 hover:shadow dark:bg-zinc-800 dark:hover:border-zinc-500 dark:hover:bg-zinc-700"
          >
            {copied ? "Copied!" : "Copy Link"}
          </button>
        </div>
      </div>

      {/* Usage Instructions */}
      <CardSection>
        <h3 className="ui-text-sm text-body font-medium">How to Use</h3>
        <ol className="ui-text-sm text-muted mt-2 list-inside list-decimal space-y-2">
          <li>
            <strong className="text-body">Link your account</strong> - Sign in to Lion Reader with
            Discord, or use <InlineCode>/link</InlineCode> with an API token
          </li>
          <li>
            <strong className="text-body">React to messages</strong> -{" "}
            {emoji ? (
              <>
                React with{" "}
                {emoji.isCustom ? (
                  <InlineCode>{emoji.text}</InlineCode>
                ) : (
                  <span className="text-base">{emoji.text}</span>
                )}{" "}
                to any message containing a URL
              </>
            ) : (
              "Add the configured emoji reaction to any message containing a URL"
            )}
            . You can also send or forward a message with a link directly to the bot in a DM.
          </li>
          <li>
            <strong className="text-body">Look for the reaction</strong> -{" "}
            {successEmoji ? (
              <>
                The bot will react with{" "}
                {successEmoji.isCustom ? (
                  <InlineCode>{successEmoji.text}</InlineCode>
                ) : (
                  <span className="text-base">{successEmoji.text}</span>
                )}{" "}
                on success
                {errorEmoji && (
                  <>
                    {" "}
                    or{" "}
                    {errorEmoji.isCustom ? (
                      <InlineCode>{errorEmoji.text}</InlineCode>
                    ) : (
                      <span className="text-base">{errorEmoji.text}</span>
                    )}{" "}
                    on failure
                  </>
                )}
              </>
            ) : (
              "The bot will react to confirm the save succeeded or failed"
            )}
          </li>
          <li>
            <strong className="text-body">Check your Saved</strong> - The article will appear in
            your Saved section
          </li>
        </ol>
      </CardSection>

      {/* Bot Commands */}
      <NoteBox className="mt-6">
        <h3 className="ui-text-sm text-body font-medium">Bot Commands</h3>
        <dl className="ui-text-sm text-muted mt-2 space-y-2">
          <div>
            <dt className="text-body inline font-mono">/status</dt>
            <dd className="ml-2 inline">- Check if your Discord account is linked</dd>
          </div>
          <div>
            <dt className="text-body inline font-mono">/link [token]</dt>
            <dd className="ml-2 inline">- Link your account using an API token</dd>
          </div>
          <div>
            <dt className="text-body inline font-mono">/unlink</dt>
            <dd className="ml-2 inline">- Remove your linked API token</dd>
          </div>
        </dl>
      </NoteBox>
    </SettingsSection>
  );
}

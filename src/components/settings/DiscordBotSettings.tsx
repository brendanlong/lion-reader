/**
 * DiscordBotSettings Component
 *
 * Settings section for the Discord bot integration.
 * Shows the bot invite link and usage instructions.
 */

"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { DiscordIcon, ExternalLinkIcon } from "@/components/ui";

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

  return (
    <section>
      <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">Discord Bot</h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        {/* Description */}
        <p className="ui-text-sm text-zinc-600 dark:text-zinc-400">
          Save articles to Lion Reader by reacting to Discord messages. When you react to a message
          containing a URL, the article will be saved to your account.
        </p>

        {/* Invite Button */}
        <div className="mt-6">
          <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-100">
            Add Bot to Server
          </h3>
          <p className="ui-text-sm mt-1 text-zinc-600 dark:text-zinc-400">
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
              className="ui-text-sm inline-flex items-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 py-2.5 font-medium text-zinc-700 shadow-sm transition-all hover:border-zinc-400 hover:bg-zinc-50 hover:shadow dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-500 dark:hover:bg-zinc-700"
            >
              {copied ? "Copied!" : "Copy Link"}
            </button>
          </div>
        </div>

        {/* Usage Instructions */}
        <div className="mt-6 border-t border-zinc-200 pt-6 dark:border-zinc-700">
          <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-100">How to Use</h3>
          <ol className="ui-text-sm mt-2 list-inside list-decimal space-y-2 text-zinc-600 dark:text-zinc-400">
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">Link your account</strong> - Sign
              in to Lion Reader with Discord, or use{" "}
              <code className="ui-text-xs rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
                /link
              </code>{" "}
              with an API token
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">React to messages</strong> -{" "}
              {emoji ? (
                <>
                  React with{" "}
                  {emoji.isCustom ? (
                    <code className="ui-text-xs rounded bg-zinc-100 px-1.5 py-0.5 font-mono dark:bg-zinc-800">
                      {emoji.text}
                    </code>
                  ) : (
                    <span className="text-base">{emoji.text}</span>
                  )}{" "}
                  to any message containing a URL
                </>
              ) : (
                "Add the configured emoji reaction to any message containing a URL"
              )}
            </li>
            <li>
              <strong className="text-zinc-900 dark:text-zinc-200">Check your Saved</strong> - The
              article will appear in your Saved section
            </li>
          </ol>
        </div>

        {/* Bot Commands */}
        <div className="mt-6 rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-700 dark:bg-zinc-800/50">
          <h3 className="ui-text-sm font-medium text-zinc-900 dark:text-zinc-100">Bot Commands</h3>
          <dl className="ui-text-sm mt-2 space-y-2 text-zinc-600 dark:text-zinc-400">
            <div>
              <dt className="inline font-mono text-zinc-800 dark:text-zinc-200">/status</dt>
              <dd className="ml-2 inline">- Check if your Discord account is linked</dd>
            </div>
            <div>
              <dt className="inline font-mono text-zinc-800 dark:text-zinc-200">/link [token]</dt>
              <dd className="ml-2 inline">- Link your account using an API token</dd>
            </div>
            <div>
              <dt className="inline font-mono text-zinc-800 dark:text-zinc-200">/unlink</dt>
              <dd className="ml-2 inline">- Remove your linked API token</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}

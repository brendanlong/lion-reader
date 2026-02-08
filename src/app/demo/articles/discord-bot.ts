import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "discord-bot",
  subscriptionId: "integrations",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/326",
  title: "Discord Bot",
  author: null,
  summary:
    "Save articles to Lion Reader directly from Discord by reacting to messages with a lion emoji.",
  publishedAt: new Date("2026-01-18T01:20:31Z"),
  starred: false,
  summaryHtml: `<p>The Lion Reader Discord bot automatically saves articles when users react to messages with a lion emoji. After linking accounts through Discord OAuth or API tokens, the bot provides instant visual feedback using custom emojis to confirm successful saves or indicate errors.</p>`,
  contentHtml: `
    <h2>Save Articles from Discord</h2>

    <p>The Lion Reader Discord bot lets you save articles without leaving Discord. When someone shares a link in a channel, just react to the message with the save emoji and the article is automatically saved to your Lion Reader account. The bot extracts URLs from message content, fetches the article, and adds it to your Saved articles.</p>

    <h3>Custom Lion Reader Emojis</h3>

    <p>The bot uses a set of custom Lion Reader emojis to communicate save results.</p>

    <div style="display: flex; gap: 2rem; align-items: flex-start; justify-content: center; flex-wrap: wrap; margin: 1.5rem 0;">
      <div style="text-align: center;">
        <img src="/emojis/savetolionreader.png" alt="Save to Lion Reader emoji" style="display: block; margin: 0 auto; width: 64px; height: 64px;" />
        <div style="margin-top: 0.5rem;"><strong>Save</strong></div>
        <div><code>:savetolionreader:</code></div>
      </div>
      <div style="text-align: center;">
        <img src="/emojis/saluting-lion-reader.png" alt="Saluting Lion Reader emoji" style="display: block; margin: 0 auto; width: 64px; height: 64px;" />
        <div style="margin-top: 0.5rem;"><strong>Success</strong></div>
        <div><code>:salutinglionreader:</code></div>
      </div>
      <div style="text-align: center;">
        <img src="/emojis/crying-lion-reader.png" alt="Crying Lion Reader emoji" style="display: block; margin: 0 auto; width: 64px; height: 64px;" />
        <div style="margin-top: 0.5rem;"><strong>Error</strong></div>
        <div><code>:cryinglionreader:</code></div>
      </div>
    </div>

    <p>We recommend uploading the Lion Reader logo as a custom emoji named <code>:savetolionreader:</code> and using it as the save trigger instead of the default lion emoji.</p>

    <h3>Linking Your Account</h3>

    <p>The bot needs to know which Lion Reader account to save articles to. There are two ways to link your account:</p>

    <ul>
      <li><strong>Discord OAuth</strong> &mdash; Sign in to Lion Reader using your Discord account. This is the easiest option &mdash; the bot automatically recognizes you by your Discord ID.</li>
      <li><strong>API token</strong> &mdash; Use the <code>/link</code> slash command with an API token generated from Settings &gt; API Tokens. This works even if you signed up with email or a different OAuth provider.</li>
    </ul>

    <h3>How It Works</h3>

    <ol>
      <li>React to any message containing a URL with the save emoji (default: <span style="font-size: 1.25rem;">&#x1F981;</span>)</li>
      <li>The bot extracts URLs from the message, filtering out Discord CDN links, Tenor, Giphy, and media file URLs</li>
      <li>Each URL is saved using the same <code>saveArticle</code> service as the web UI and MCP server</li>
      <li>The bot reacts with <img src="/emojis/saluting-lion-reader.png" alt="saluting lion" style="display: inline; margin: 0; width: 1.25em; height: 1.25em; vertical-align: middle;" /> on success or <img src="/emojis/crying-lion-reader.png" alt="crying lion" style="display: inline; margin: 0; width: 1.25em; height: 1.25em; vertical-align: middle;" /> on failure</li>
    </ol>

    <h3>Slash Commands</h3>

    <p>The bot registers three slash commands:</p>

    <ul>
      <li><code>/status</code> &mdash; Check if your Discord account is linked to Lion Reader and which method is being used (OAuth or API token)</li>
      <li><code>/link [token]</code> &mdash; Link your account using an API token from Settings &gt; API Tokens. The token needs the &ldquo;Save articles&rdquo; scope.</li>
      <li><code>/unlink</code> &mdash; Remove your linked API token. If you&rsquo;re also connected via Discord OAuth, saving will continue to work.</li>
    </ul>

    <p>All command responses are ephemeral &mdash; only you can see them, so your API token stays private.</p>

    <h3>Adding the Bot to Your Server</h3>

    <p>The bot can be added to any Discord server using the invite link in Settings &gt; Discord Bot. It requests only the permissions it needs: viewing channels, sending messages, adding reactions, reading message history, and using external emojis. Once added, anyone in the server who has linked their Lion Reader account can use the save emoji to save articles.</p>

    <h3>Configuration</h3>

    <p>Server administrators can customize the bot&rsquo;s behavior through environment variables:</p>

    <ul>
      <li><code>DISCORD_SAVE_EMOJI</code> &mdash; The emoji that triggers saving (default: <span style="font-size: 1.25rem;">&#x1F981;</span>). We recommend using <code>:savetolionreader:</code> with the Lion Reader logo emoji instead, but this must be configured for each server.</li>
      <li><code>DISCORD_SUCCESS_EMOJI</code> &mdash; Custom emoji name for successful saves (default: <code>:salutinglionreader:</code>)</li>
      <li><code>DISCORD_ERROR_EMOJI</code> &mdash; Custom emoji name for failed saves (default: <code>:cryinglionreader:</code>)</li>
    </ul>

    <p>The bot is built with <a href="https://discord.js.org/" target="_blank" rel="noopener noreferrer">discord.js</a> and runs as a standalone process alongside the main application server.</p>
  `,
};

export default article;

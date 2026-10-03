import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "discord-bot",
  subscriptionId: "integrations",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/326",
  title: "Discord Bot",
  author: null,
  summary:
    "Save articles to Lion Reader directly from Discord by reacting to messages with a lion emoji, or by sending a link to the bot in a DM.",
  publishedAt: new Date("2026-01-18T01:20:31Z"),
  starred: false,
  summaryHtml: `<p>The Lion Reader Discord bot automatically saves articles when users react to messages with a lion emoji or send a link to the bot in a DM. After linking accounts through Discord OAuth or API tokens, the bot provides instant visual feedback using custom emojis to confirm successful saves or indicate errors.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-07-13"),
  contentHtml: `
    <p>See a good link in a <a href="https://discord.com/" target="_blank" rel="noopener noreferrer">Discord</a> channel? React to the message with the save emoji and the Lion Reader bot saves the article to your reading list. You can also send or forward a link to the bot in a direct message. The bot reacts back so you know it worked.</p>

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

    <h3>Getting Started</h3>

    <p>Add the bot to your server with the invite link in Settings. If you sign in to Lion Reader with Discord, the bot already knows who you are. Otherwise, link your account with the <code>/link</code> command and a token from Settings &mdash; only you can see the bot&rsquo;s replies, so your token stays private. Anyone in the server who has linked their account can save with a reaction.</p>

    <p>Server admins can upload the Lion Reader logo above as a custom emoji to use as the save button; otherwise the bot listens for the lion emoji (&#x1F981;).</p>
  `,
};

export default article;

import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "discord-bot",
  subscriptionId: "integrations",
  type: "web",
  url: "https://github.com/brendanlong/lion-reader/pull/326",
  title: "Discord Bot",
  author: null,
  summary:
    "Save articles to Lion Reader directly from Discord by reacting to messages with the Lion Reader emoji, or by sending a link to the bot in a DM.",
  publishedAt: new Date("2026-01-18T01:20:31Z"),
  starred: false,
  summaryHtml: `<p>React to a link in Discord with the save emoji, or send it to the bot, and it&rsquo;s added to your saved articles. An admin installs the bot and emoji; members link their account via Discord sign-in or the <strong>/link</strong> command, and each person&rsquo;s saves stay their own.</p>`,
  summaryModelId: "claude-sonnet-5",
  summaryGeneratedAt: new Date("2026-10-03"),
  contentHtml: `
    <p>See a good link in a <a href="https://discord.com/" target="_blank" rel="noopener noreferrer">Discord</a> channel? React to the message with the save emoji and the Lion Reader bot adds the article to your <a href="/demo/all?entry=save-for-later">saved articles</a>. If you&rsquo;re in a server with the bot, you can also send or forward links to it in a direct message. The bot reacts back so you know whether it worked.</p>

    <div style="display: flex; gap: 2rem; align-items: flex-start; justify-content: center; flex-wrap: wrap; margin: 1.5rem 0;">
      <div style="text-align: center;">
        <img src="/emojis/savetolionreader.png" alt="Save to Lion Reader emoji" style="display: block; margin: 0 auto; width: 64px; height: 64px;" />
        <div style="margin-top: 0.5rem;"><strong>Save</strong></div>
        <div><code>:savetolionreader:</code></div>
      </div>
      <div style="text-align: center;">
        <img src="/emojis/saluting-lion-reader.png" alt="Saluting Lion Reader emoji" style="display: block; margin: 0 auto; width: 64px; height: 64px;" />
        <div style="margin-top: 0.5rem;"><strong>Saved</strong></div>
      </div>
      <div style="text-align: center;">
        <img src="/emojis/crying-lion-reader.png" alt="Crying Lion Reader emoji" style="display: block; margin: 0 auto; width: 64px; height: 64px;" />
        <div style="margin-top: 0.5rem;"><strong>Couldn&rsquo;t save</strong></div>
      </div>
    </div>

    <h3>Setting Up a Server</h3>

    <p>A server admin adds the bot with the invite link in Lion Reader&rsquo;s Settings, then adds the image labeled <strong>Save</strong> above as a custom emoji named <code>savetolionreader</code>. Direct messages work without the emoji.</p>

    <h3>Linking Your Account</h3>

    <p>If you sign in to Lion Reader with Discord, the bot already knows who you are. Otherwise, link your account with the <code>/link</code> command and an API token from Settings &mdash; only you can see the bot&rsquo;s replies, so your token stays private. Everyone in the server who links their account can save with a reaction, and each person&rsquo;s saves go to their own reading list.</p>
  `,
};

export default article;

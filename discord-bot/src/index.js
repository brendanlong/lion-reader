import "dotenv/config";
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from "discord.js";
import { loadTokens, saveToken, removeToken, getToken } from "./storage.js";
import { saveArticle } from "./api.js";
import { extractUrls } from "./urls.js";

const SAVE_EMOJI = process.env.SAVE_EMOJI || "🦁";
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN environment variable is required");
  process.exit(1);
}

if (!DISCORD_CLIENT_ID) {
  console.error("DISCORD_CLIENT_ID environment variable is required");
  process.exit(1);
}

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Reaction],
});

// Register slash commands
const commands = [
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("Link your Lion Reader API token")
    .addStringOption((option) =>
      option
        .setName("token")
        .setDescription("Your Lion Reader API token (get from Settings > API Tokens)")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("unlink")
    .setDescription("Remove your linked Lion Reader account"),
  new SlashCommandBuilder().setName("status").setDescription("Check if your account is linked"),
].map((command) => command.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), {
      body: commands,
    });
    console.log("Slash commands registered");
  } catch (error) {
    console.error("Failed to register commands:", error);
  }
}

// Handle slash commands
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  if (commandName === "link") {
    const token = interaction.options.getString("token", true);

    // Validate token by making a test request
    const result = await saveArticle(token, "https://example.com", true);

    if (result.error === "unauthorized") {
      await interaction.reply({
        content: "Invalid API token. Please check your token and try again.",
        ephemeral: true,
      });
      return;
    }

    // Token is valid, save it
    saveToken(user.id, token);
    await interaction.reply({
      content:
        `Your Lion Reader account is now linked. ` +
        `React to any message containing a URL with ${SAVE_EMOJI} to save it.`,
      ephemeral: true,
    });
  } else if (commandName === "unlink") {
    const hadToken = getToken(user.id) !== null;
    removeToken(user.id);
    await interaction.reply({
      content: hadToken
        ? "Your Lion Reader account has been unlinked."
        : "You don't have a linked account.",
      ephemeral: true,
    });
  } else if (commandName === "status") {
    const token = getToken(user.id);
    await interaction.reply({
      content: token
        ? `Your account is linked. React to messages with ${SAVE_EMOJI} to save articles.`
        : `Your account is not linked. Use \`/link\` with your API token to connect.`,
      ephemeral: true,
    });
  }
});

// Handle reactions
client.on("messageReactionAdd", async (reaction, user) => {
  // Ignore bot reactions
  if (user.bot) return;

  // Check if it's the save emoji
  const emoji = reaction.emoji.name;
  if (emoji !== SAVE_EMOJI) return;

  // Get user's token
  const token = getToken(user.id);
  if (!token) {
    // User hasn't linked their account - silently ignore
    // They might just be reacting for other reasons
    return;
  }

  // Fetch the full message if it's a partial
  let message = reaction.message;
  if (message.partial) {
    try {
      message = await message.fetch();
    } catch (error) {
      console.error("Failed to fetch message:", error);
      return;
    }
  }

  // Extract URLs from message
  const urls = extractUrls(message.content);
  if (urls.length === 0) {
    // No URLs in message - silently ignore
    return;
  }

  // Save each URL and collect results
  const results = [];
  for (const url of urls) {
    const result = await saveArticle(token, url);

    if (result.success) {
      console.log(`Saved article for ${user.tag}: ${url}`);
      const title = result.data?.title || url;
      results.push({ success: true, title, url });
    } else if (result.error === "unauthorized") {
      // Token may have been revoked
      console.log(`Token invalid for ${user.tag}, removing...`);
      removeToken(user.id);
      try {
        await user.send(
          "Your Lion Reader API token appears to be invalid. " +
            "Please use `/link` to reconnect with a new token."
        );
      } catch {
        // May not be able to DM user
      }
      return;
    } else {
      console.error(`Failed to save article for ${user.tag}: ${url}`, result.error);
      results.push({ success: false, url, error: result.error });
    }
  }

  // DM user with results
  if (results.length > 0) {
    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    let dmMessage = "";
    if (successCount > 0) {
      const saved = results.filter((r) => r.success);
      if (saved.length === 1) {
        dmMessage = `Saved to Lion Reader: **${saved[0].title}**`;
      } else {
        dmMessage = `Saved ${saved.length} articles to Lion Reader:\n${saved.map((r) => `• ${r.title}`).join("\n")}`;
      }
    }
    if (failCount > 0) {
      const failed = results.filter((r) => !r.success);
      if (dmMessage) dmMessage += "\n\n";
      dmMessage += `Failed to save: ${failed.map((r) => r.url).join(", ")}`;
    }

    try {
      await user.send(dmMessage);
    } catch {
      // User may have DMs disabled - fall back to reaction
      try {
        await message.react(failCount > 0 ? "❌" : "✅");
      } catch {
        // May not have permission to react either
      }
    }
  }
});

// Bot ready
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Save emoji: ${SAVE_EMOJI}`);
  console.log(`Linked users: ${loadTokens().size}`);
});

// Start the bot
await registerCommands();
client.login(DISCORD_TOKEN);

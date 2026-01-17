# Lion Reader Discord Bot

A Discord bot that saves articles to Lion Reader when you react to messages with a specific emoji.

## How It Works

1. React to any message containing a URL with the 🦁 emoji (configurable)
2. The bot extracts the URL and saves it to your Lion Reader account
3. A ✅ reaction confirms the save succeeded

## Setup

### 1. Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to the "Bot" section and click "Add Bot"
4. Under "Privileged Gateway Intents", enable:
   - **Message Content Intent** (required to read message content)
5. Copy the bot token for later

### 2. Get the Client ID

1. In the Discord Developer Portal, go to "OAuth2" > "General"
2. Copy the "Client ID"

### 3. Invite the Bot to Your Server

1. Go to "OAuth2" > "URL Generator"
2. Select scopes: `bot`, `applications.commands`
3. Select bot permissions:
   - Read Messages/View Channels
   - Send Messages
   - Add Reactions
   - Read Message History
4. Copy the generated URL and open it to invite the bot

### 4. Configure the Bot

```bash
cd discord-bot
cp .env.example .env
```

Edit `.env` with your values:

```
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_client_id_here
LION_READER_URL=https://lionreader.app
SAVE_EMOJI=🦁
```

### 5. Install and Run

```bash
npm install
npm start
```

For development with auto-reload:

```bash
npm run dev
```

## User Commands

| Command         | Description                     |
| --------------- | ------------------------------- |
| `/link <token>` | Link your Lion Reader API token |
| `/unlink`       | Remove your linked account      |
| `/status`       | Check if your account is linked |

## Getting a Lion Reader API Token

1. Log into Lion Reader
2. Go to Settings > API Tokens
3. Create a new token with the "Save articles" scope
4. Copy the token and use `/link <token>` in Discord

## Configuration

| Environment Variable | Default                  | Description                             |
| -------------------- | ------------------------ | --------------------------------------- |
| `DISCORD_TOKEN`      | (required)               | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID`  | (required)               | Application client ID                   |
| `LION_READER_URL`    | `https://lionreader.app` | Lion Reader instance URL                |
| `SAVE_EMOJI`         | `🦁`                     | Emoji that triggers saving              |

## Deployment

The bot can be deployed anywhere that runs Node.js. Some options:

- **Railway/Render/Fly.io** - Easy deployment with environment variables
- **VPS** - Run with PM2 or systemd for process management
- **Docker** - Build and run as a container

### PM2 Example

```bash
npm install -g pm2
pm2 start src/index.js --name lion-reader-bot
pm2 save
```

## Security Notes

- API tokens are stored in `data/tokens.json` (gitignored)
- Tokens are validated before being stored
- Invalid tokens are automatically removed
- All `/link` responses are ephemeral (only visible to the user)

## Troubleshooting

**Bot doesn't respond to reactions:**

- Make sure "Message Content Intent" is enabled in Discord Developer Portal
- Check that the bot has permission to read messages in the channel

**"Invalid API token" error:**

- Make sure the token has the "Save articles" (`saved:write`) scope
- Try creating a new token in Lion Reader settings

**Bot can't DM users:**

- Users may have DMs disabled from server members
- This only affects the "token revoked" notification

#!/bin/bash
# Start API, worker, and optionally Discord bot in the same VM
# Worker runs at lower CPU priority (nice 10) to avoid starving the API
# If any process exits, concurrently kills the others and exits

set -e

# Use concurrently to manage processes
# --kill-others: kill all processes if one exits
if [ -n "$DISCORD_BOT_TOKEN" ]; then
  exec npx concurrently --kill-others --names "worker,api,discord" \
    "nice -n 10 node dist/worker.js" \
    "node node_modules/next/dist/bin/next start" \
    "node dist/discord-bot.js"
else
  exec npx concurrently --kill-others --names "worker,api" \
    "nice -n 10 node dist/worker.js" \
    "node node_modules/next/dist/bin/next start"
fi

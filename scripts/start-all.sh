#!/bin/bash
# Start API, worker, and optionally Discord bot in the same VM.
# Worker runs at lower CPU priority (nice 10) to avoid starving the API.
#
# Plain bash job control (no concurrently): the production image ships only
# Next's traced standalone node_modules, which doesn't include concurrently.
# If any process exits, the others are killed and its exit code is propagated.
# SIGTERM/SIGINT are forwarded so each process can shut down gracefully.

pids=()

nice -n 10 node dist/worker.js &
pids+=($!)

node dist/server.js &
pids+=($!)

if [ -n "$DISCORD_BOT_TOKEN" ]; then
  node dist/discord-bot.js &
  pids+=($!)
fi

forward_term() {
  kill -TERM "${pids[@]}" 2>/dev/null
}
trap forward_term SIGTERM SIGINT

# Block until the first process exits (or a signal interrupts the wait), then
# take the rest down and propagate the exit code.
wait -n "${pids[@]}"
code=$?
kill -TERM "${pids[@]}" 2>/dev/null
wait
exit "$code"

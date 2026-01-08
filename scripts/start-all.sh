#!/bin/bash
# Start both API and worker in the same VM
# Worker runs at lower CPU priority (nice 10) to avoid starving the API
# If either process exits, concurrently kills the other and exits

set -e

# Disable embedded worker since we're running a separate worker process
export DISABLE_EMBEDDED_WORKER=true

# Use concurrently to manage both processes
# --kill-others: kill all processes if one exits
# --kill-others-on-fail: kill all processes if one exits with non-zero
exec npx concurrently --kill-others --names "worker,api" \
  "nice -n 10 node dist/worker.js" \
  "node node_modules/next/dist/bin/next start"

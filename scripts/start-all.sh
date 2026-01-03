#!/bin/bash
# Start both API and worker in the same VM
# Worker runs at lower CPU priority (nice 10) to avoid starving the API

set -e

# Start worker in background with lower CPU priority
echo "Starting background worker (nice 10)..."
nice -n 10 pnpm worker &
WORKER_PID=$!

# Forward signals to worker for graceful shutdown
cleanup() {
  echo "Shutting down..."
  kill $WORKER_PID 2>/dev/null || true
  wait $WORKER_PID 2>/dev/null || true
}
trap cleanup SIGTERM SIGINT

# Start API in foreground
echo "Starting API server..."
exec pnpm start

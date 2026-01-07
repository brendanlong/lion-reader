#!/bin/bash
# Start both API and worker in the same VM
# Worker runs at lower CPU priority (nice 10) to avoid starving the API

set -e

# Start bundled worker in background with lower CPU priority
# Uses the pre-built bundle (no tsx or TypeScript compilation needed)
echo "Starting background worker (nice 10)..."
nice -n 10 node dist/worker.js &
WORKER_PID=$!

# Forward signals to worker for graceful shutdown
cleanup() {
  echo "Shutting down..."
  kill $WORKER_PID 2>/dev/null || true
  wait $WORKER_PID 2>/dev/null || true
}
trap cleanup SIGTERM SIGINT EXIT

# Start API in foreground
echo "Starting API server..."
pnpm start

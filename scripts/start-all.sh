#!/bin/bash
# Start both API and worker in the same VM
# Worker runs at lower CPU priority (nice 10) to avoid starving the API
# If either process exits, the script exits so Fly.io will restart the container

set -e

# Disable embedded worker since we're running a separate worker process
export DISABLE_EMBEDDED_WORKER=true

# Start bundled worker in background with lower CPU priority
# Uses the pre-built bundle (no tsx or TypeScript compilation needed)
echo "Starting background worker (nice 10)..."
nice -n 10 node dist/worker.js &
WORKER_PID=$!

# Start API in background
echo "Starting API server..."
node node_modules/next/dist/bin/next start &
API_PID=$!

# Forward signals to both processes for graceful shutdown
cleanup() {
  echo "Shutting down..."
  kill $WORKER_PID 2>/dev/null || true
  kill $API_PID 2>/dev/null || true
  wait
}
trap cleanup SIGTERM SIGINT

# Wait for either process to exit - if one dies, exit so Fly.io restarts us
wait -n $WORKER_PID $API_PID
EXIT_CODE=$?

echo "A process exited with code $EXIT_CODE, shutting down..."
cleanup
exit $EXIT_CODE

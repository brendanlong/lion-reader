# WebSub Test Environment

This directory contains a local WebSub testing environment for debugging Lion Reader's WebSub implementation.

## Components

1. **Hub Server** (`hub.js`) - A simple WebSub hub that:
   - Accepts subscription requests
   - Sends verification challenges
   - Distributes content to subscribers
   - Logs all requests/responses in detail

2. **Feed Server** (`feed-server.js`) - A mock Atom feed publisher that:
   - Serves an Atom feed with WebSub hub link
   - Allows adding entries dynamically
   - Can ping the hub to trigger distribution

3. **Test Script** (`test-websub.js`) - Automated tests for the WebSub flow

## Quick Start

### 1. Start the services

In three separate terminals:

```bash
# Terminal 1: Hub server (port 9000)
cd websub-test
npm run hub

# Terminal 2: Feed server (port 9001)
cd websub-test
npm run feed

# Terminal 3: Lion Reader (port 3000)
# In the main lion-reader directory:
WEBSUB_ENABLED=true NEXT_PUBLIC_APP_URL=http://localhost:3000 pnpm dev
```

### 2. Subscribe to the test feed

In Lion Reader, subscribe to: `http://localhost:9001/feed.atom`

This will:

1. Lion Reader fetches the feed and discovers the hub URL
2. Lion Reader sends a subscription request to the hub
3. The hub sends a verification challenge to Lion Reader
4. Lion Reader echoes back the challenge
5. The hub confirms the subscription

### 3. Test content notification

Add a new entry and trigger distribution:

```bash
# Add an entry and ping the hub
curl -X POST http://localhost:9001/update-and-ping \
  -H "Content-Type: application/json" \
  -d '{"title": "Test Entry", "content": "Hello WebSub!"}'
```

Or manually:

```bash
# Add an entry
curl -X POST http://localhost:9001/add-entry \
  -H "Content-Type: application/json" \
  -d '{"title": "Test Entry", "content": "Hello WebSub!"}'

# Ping the hub
curl -X POST http://localhost:9001/ping-hub
```

### 4. Check status

```bash
# Hub subscriptions
curl http://localhost:9000/status

# Feed status
curl http://localhost:9001/status
```

## Running automated tests

```bash
# Run full test (requires test callback server)
npm run test

# Test subscription only
npm run test -- --subscribe-only

# Test notification only (needs active subscription)
npm run test -- --notify-only
```

## Environment Variables

| Variable       | Default                   | Description                                      |
| -------------- | ------------------------- | ------------------------------------------------ |
| `HUB_PORT`     | 9000                      | Port for the hub server                          |
| `FEED_PORT`    | 9001                      | Port for the feed server                         |
| `HUB_URL`      | http://localhost:9000/hub | Hub URL for subscriptions                        |
| `TEST_FEED_ID` | (none)                    | Feed ID in Lion Reader for testing notifications |

## Debugging Lion Reader

1. Make sure Lion Reader is running with WebSub enabled:

   ```bash
   WEBSUB_ENABLED=true NEXT_PUBLIC_APP_URL=http://localhost:3000 pnpm dev
   ```

2. Check the Lion Reader logs for WebSub-related messages

3. Check the hub logs to see verification requests/responses

4. The hub logs all requests with full headers and bodies

## Common Issues

### "WebSub is not available (no public callback URL)"

Make sure `NEXT_PUBLIC_APP_URL` is set and `WEBSUB_ENABLED=true`.

### Verification fails with "Subscription not found"

The feed ID in the callback URL doesn't match any pending subscription in the database. Make sure:

1. Lion Reader actually sent a subscription request
2. The feed ID is correct

### Verification fails with "Topic mismatch"

The topic URL in the verification doesn't match what Lion Reader subscribed to. Check:

1. The `selfUrl` vs `url` in the feed
2. URL normalization differences

### Signature verification fails

The HMAC signature doesn't match. Check:

1. The secret is correctly stored
2. The body content matches exactly
3. The algorithm (sha1, sha256) is correct

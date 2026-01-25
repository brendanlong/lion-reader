#!/usr/bin/env node
/**
 * WebSub Test Script
 *
 * This script tests the full WebSub flow:
 * 1. Subscribes Lion Reader to the test feed via the hub
 * 2. Adds a new entry to the feed
 * 3. Triggers the hub to distribute the update
 * 4. Verifies Lion Reader received the notification
 *
 * Prerequisites:
 * - Hub server running on port 9000
 * - Feed server running on port 9001
 * - Lion Reader running on port 3000 (or LION_READER_URL env var)
 *
 * Usage:
 *   node test-websub.js
 *   node test-websub.js --subscribe-only   # Only test subscription
 *   node test-websub.js --notify-only      # Only test notification (needs active subscription)
 */

const HUB_URL = process.env.HUB_URL || "http://localhost:9000/hub";
const FEED_URL = process.env.FEED_URL || "http://localhost:9001/feed.atom";
const LION_READER_URL = process.env.LION_READER_URL || "http://localhost:3000";
const FEED_SERVER_URL = process.env.FEED_SERVER_URL || "http://localhost:9001";

// For testing, we need a valid feed ID. This can be passed as env var
// In real usage, you'd subscribe via Lion Reader first
const TEST_FEED_ID = process.env.TEST_FEED_ID;

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkServices() {
  console.log("\n=== Checking Services ===\n");

  const services = [
    { name: "Hub", url: HUB_URL.replace("/hub", "/status") },
    { name: "Feed Server", url: FEED_SERVER_URL + "/status" },
    { name: "Lion Reader", url: LION_READER_URL },
  ];

  for (const service of services) {
    try {
      const response = await fetch(service.url, { method: "GET" });
      console.log(`[OK] ${service.name} is running (${response.status})`);
    } catch (error) {
      console.log(`[ERROR] ${service.name} is not reachable: ${error.message}`);
      return false;
    }
  }

  return true;
}

async function manualSubscriptionTest() {
  console.log("\n=== Manual Subscription Test ===\n");
  console.log("This tests subscribing directly to the hub (bypassing Lion Reader)\n");

  // Create a test callback that we'll intercept
  const testCallbackPort = 9999;
  const testCallback = `http://localhost:${testCallbackPort}/callback`;

  console.log(`1. Sending subscription request to hub...`);
  console.log(`   Topic: ${FEED_URL}`);
  console.log(`   Callback: ${testCallback}`);
  console.log(`   Hub: ${HUB_URL}\n`);

  // Start a temporary server to receive the verification
  const { createServer } = await import("http");

  const verificationPromise = new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      console.log(`\n>>> Received verification request: ${req.method} ${req.url}`);

      const url = new URL(req.url, `http://localhost:${testCallbackPort}`);
      const challenge = url.searchParams.get("hub.challenge");
      const mode = url.searchParams.get("hub.mode");
      const topic = url.searchParams.get("hub.topic");

      console.log(`   Mode: ${mode}`);
      console.log(`   Topic: ${topic}`);
      console.log(`   Challenge: ${challenge}`);

      if (challenge) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(challenge);
        console.log(`   Responded with challenge`);
        server.close();
        resolve({ success: true, challenge, mode, topic });
      } else {
        res.writeHead(400);
        res.end("Missing challenge");
        reject(new Error("Missing challenge"));
      }
    });

    server.listen(testCallbackPort, () => {
      console.log(`   Test callback server listening on port ${testCallbackPort}`);
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      server.close();
      reject(new Error("Timeout waiting for verification"));
    }, 10000);
  });

  // Send subscription request
  const subscribeResponse = await fetch(HUB_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.topic": FEED_URL,
      "hub.callback": testCallback,
      "hub.secret": "test-secret-12345",
      "hub.verify": "async",
    }).toString(),
  });

  console.log(`\n2. Hub response: ${subscribeResponse.status}`);
  const responseText = await subscribeResponse.text();
  console.log(`   Body: ${responseText}`);

  if (subscribeResponse.status !== 202 && subscribeResponse.status !== 204) {
    console.log("\n[ERROR] Hub did not accept subscription request");
    return false;
  }

  console.log("\n3. Waiting for verification callback...");

  try {
    await verificationPromise;
    console.log(`\n[OK] Verification successful!`);
    return true;
  } catch (error) {
    console.log(`\n[ERROR] Verification failed: ${error.message}`);
    return false;
  }
}

async function testNotification() {
  console.log("\n=== Testing Content Notification ===\n");

  if (!TEST_FEED_ID) {
    console.log("No TEST_FEED_ID provided. Skipping Lion Reader notification test.");
    console.log(
      "To test with Lion Reader, subscribe to the test feed first, then set TEST_FEED_ID.\n"
    );

    // Just test hub -> feed server flow
    console.log("Testing hub content distribution...\n");

    // Add an entry and trigger distribution
    console.log("1. Adding new entry to feed...");
    const addResponse = await fetch(FEED_SERVER_URL + "/update-and-ping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `Test Entry ${Date.now()}`,
        content: `This entry was created at ${new Date().toISOString()} to test WebSub distribution.`,
      }),
    });

    const addResult = await addResponse.json();
    console.log("   Result:", JSON.stringify(addResult, null, 2));

    return true;
  }

  // Full test with Lion Reader
  const callbackUrl = `${LION_READER_URL}/api/webhooks/websub/${TEST_FEED_ID}`;
  console.log(`Testing notification to: ${callbackUrl}\n`);

  // First, check the hub's subscription status
  console.log("1. Checking hub subscriptions...");
  const statusResponse = await fetch(HUB_URL.replace("/hub", "/status"));
  const status = await statusResponse.json();
  console.log("   Subscriptions:", JSON.stringify(status, null, 2));

  // Add a new entry and trigger
  console.log("\n2. Adding entry and pinging hub...");
  const updateResponse = await fetch(FEED_SERVER_URL + "/update-and-ping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: `Lion Reader Test ${Date.now()}`,
      content: `Testing WebSub notification to Lion Reader at ${new Date().toISOString()}`,
    }),
  });

  const updateResult = await updateResponse.json();
  console.log("   Result:", JSON.stringify(updateResult, null, 2));

  return true;
}

async function simulateLionReaderSubscription() {
  console.log("\n=== Simulating Lion Reader Subscription Request ===\n");

  if (!TEST_FEED_ID) {
    console.log("No TEST_FEED_ID provided. Cannot simulate Lion Reader subscription.");
    console.log("Subscribe to a feed in Lion Reader first to get a feed ID.\n");
    return false;
  }

  const callbackUrl = `${LION_READER_URL}/api/webhooks/websub/${TEST_FEED_ID}`;
  const secret = "test-secret-" + Date.now();

  console.log("Subscription details:");
  console.log(`  Topic: ${FEED_URL}`);
  console.log(`  Callback: ${callbackUrl}`);
  console.log(`  Hub: ${HUB_URL}`);
  console.log(`  Secret: ${secret}`);

  console.log("\n1. Sending subscription request to hub...");

  const response = await fetch(HUB_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.topic": FEED_URL,
      "hub.callback": callbackUrl,
      "hub.secret": secret,
      "hub.verify": "async",
    }).toString(),
  });

  console.log(`   Hub response: ${response.status}`);
  const responseText = await response.text();
  console.log(`   Body: ${responseText}`);

  console.log("\n2. Waiting for hub to verify with Lion Reader...");
  await sleep(2000);

  // Check subscription status
  console.log("\n3. Checking hub subscriptions...");
  const statusResponse = await fetch(HUB_URL.replace("/hub", "/status"));
  const status = await statusResponse.json();
  console.log("   Subscriptions:", JSON.stringify(status, null, 2));

  return true;
}

async function main() {
  const args = process.argv.slice(2);

  console.log("=".repeat(80));
  console.log("WebSub Test Script");
  console.log("=".repeat(80));
  console.log("\nConfiguration:");
  console.log(`  Hub URL: ${HUB_URL}`);
  console.log(`  Feed URL: ${FEED_URL}`);
  console.log(`  Lion Reader: ${LION_READER_URL}`);
  console.log(`  Test Feed ID: ${TEST_FEED_ID || "(not set)"}`);

  // Check all services are running
  const servicesOk = await checkServices();
  if (!servicesOk) {
    console.log("\n[ERROR] Some services are not running. Start them first:");
    console.log("  cd websub-test && npm run hub");
    console.log("  cd websub-test && npm run feed");
    console.log("  pnpm dev (for Lion Reader)");
    process.exit(1);
  }

  if (args.includes("--subscribe-only")) {
    await manualSubscriptionTest();
  } else if (args.includes("--notify-only")) {
    await testNotification();
  } else if (args.includes("--simulate-lion-reader")) {
    await simulateLionReaderSubscription();
  } else {
    // Full test
    console.log("\n=== Running Full Test ===");
    console.log("1. Testing manual subscription (hub -> test callback)");
    await manualSubscriptionTest();

    console.log("\n2. Testing content notification");
    await testNotification();
  }

  console.log("\n" + "=".repeat(80));
  console.log("Test complete!");
  console.log("=".repeat(80));
}

main().catch(console.error);

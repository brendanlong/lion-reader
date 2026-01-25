/**
 * Simple WebSub Hub for testing Lion Reader's WebSub implementation.
 *
 * This hub implements the WebSub (PubSubHubbub) protocol:
 * - Accepts subscription requests (hub.mode=subscribe)
 * - Sends verification challenges to callback URLs
 * - Distributes content to subscribers when publishers ping
 *
 * Reference: https://www.w3.org/TR/websub/
 */

import express from "express";
import crypto from "crypto";

const app = express();
const PORT = process.env.HUB_PORT || 9000;

// Parse URL-encoded bodies (subscription requests)
app.use(express.urlencoded({ extended: true }));
// Parse raw bodies for content distribution
app.use(express.raw({ type: "*/*", limit: "10mb" }));

// Store subscriptions: Map<topicUrl, Array<Subscription>>
const subscriptions = new Map();

/**
 * @typedef {Object} Subscription
 * @property {string} callback - Callback URL to receive notifications
 * @property {string} topic - Topic URL being subscribed to
 * @property {string} secret - HMAC secret for signing notifications
 * @property {number} leaseSeconds - How long the subscription lasts
 * @property {Date} expiresAt - When the subscription expires
 * @property {string} state - "pending" | "active"
 */

// Detailed request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log("\n" + "=".repeat(80));
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  console.log("Headers:", JSON.stringify(req.headers, null, 2));

  if (req.method === "POST" && req.is("application/x-www-form-urlencoded")) {
    console.log("Body (parsed):", req.body);
  } else if (req.body && Buffer.isBuffer(req.body)) {
    console.log("Body (raw, first 500 chars):", req.body.toString("utf-8").slice(0, 500));
  }

  // Capture response
  const originalSend = res.send.bind(res);
  res.send = (body) => {
    console.log(`Response: ${res.statusCode}`, body ? body.toString().slice(0, 200) : "(empty)");
    console.log("=".repeat(80));
    return originalSend(body);
  };

  next();
});

/**
 * POST /hub - Handle subscription requests
 *
 * Expected form parameters:
 * - hub.mode: "subscribe" or "unsubscribe"
 * - hub.topic: URL of the topic to subscribe to
 * - hub.callback: URL to receive notifications
 * - hub.secret: (optional) Secret for HMAC signing
 * - hub.lease_seconds: (optional) Requested subscription duration
 */
app.post("/hub", async (req, res) => {
  const mode = req.body["hub.mode"];
  const topic = req.body["hub.topic"];
  const callback = req.body["hub.callback"];
  const secret = req.body["hub.secret"] || "";
  const leaseSecondsStr = req.body["hub.lease_seconds"];
  const verify = req.body["hub.verify"]; // "sync" or "async"

  console.log("\n>>> Subscription Request:");
  console.log("  Mode:", mode);
  console.log("  Topic:", topic);
  console.log("  Callback:", callback);
  console.log("  Secret:", secret ? `[${secret.length} chars]` : "(none)");
  console.log("  Lease:", leaseSecondsStr || "(default)");
  console.log("  Verify:", verify || "(not specified)");

  // Validate required parameters
  if (!mode || !topic || !callback) {
    console.log("<<< ERROR: Missing required parameters");
    return res.status(400).send("Missing required parameters: hub.mode, hub.topic, hub.callback");
  }

  if (mode !== "subscribe" && mode !== "unsubscribe") {
    console.log("<<< ERROR: Invalid mode");
    return res.status(400).send("Invalid hub.mode: must be 'subscribe' or 'unsubscribe'");
  }

  // Parse lease seconds (default to 1 day)
  const leaseSeconds = leaseSecondsStr ? parseInt(leaseSecondsStr, 10) : 86400;

  // Generate a random challenge
  const challenge = crypto.randomBytes(32).toString("hex");

  console.log("\n>>> Sending verification challenge to callback...");
  console.log("  Challenge:", challenge);

  // Build verification URL
  const verifyUrl = new URL(callback);
  verifyUrl.searchParams.set("hub.mode", mode);
  verifyUrl.searchParams.set("hub.topic", topic);
  verifyUrl.searchParams.set("hub.challenge", challenge);
  verifyUrl.searchParams.set("hub.lease_seconds", leaseSeconds.toString());

  console.log("  Verification URL:", verifyUrl.toString());

  // Send async response first (202 Accepted)
  // Then verify the callback
  res.status(202).send("Subscription request accepted, verification pending");

  // Verify callback asynchronously
  try {
    const verifyResponse = await fetch(verifyUrl.toString(), {
      method: "GET",
      headers: {
        "User-Agent": "WebSub-Test-Hub/1.0",
      },
    });

    console.log("\n>>> Verification response:");
    console.log("  Status:", verifyResponse.status);

    const responseBody = await verifyResponse.text();
    console.log("  Body:", responseBody.slice(0, 200));

    if (verifyResponse.status !== 200) {
      console.log("<<< Verification FAILED: Non-200 status");
      return;
    }

    // Check if response body matches the challenge
    if (responseBody.trim() !== challenge) {
      console.log("<<< Verification FAILED: Challenge mismatch");
      console.log("  Expected:", challenge);
      console.log("  Got:", responseBody.trim());
      return;
    }

    console.log("<<< Verification SUCCESS!");

    // Store the subscription
    const subscription = {
      callback,
      topic,
      secret,
      leaseSeconds,
      expiresAt: new Date(Date.now() + leaseSeconds * 1000),
      state: "active",
    };

    if (!subscriptions.has(topic)) {
      subscriptions.set(topic, []);
    }

    // Remove any existing subscription for this callback
    const topicSubs = subscriptions.get(topic);
    const existingIdx = topicSubs.findIndex((s) => s.callback === callback);
    if (existingIdx >= 0) {
      topicSubs.splice(existingIdx, 1);
    }

    if (mode === "subscribe") {
      topicSubs.push(subscription);
      console.log(`>>> Subscription stored. Total subscribers for ${topic}: ${topicSubs.length}`);
    } else {
      console.log(`>>> Unsubscribed. Remaining subscribers for ${topic}: ${topicSubs.length}`);
    }
  } catch (error) {
    console.log("<<< Verification FAILED: Error contacting callback");
    console.log("  Error:", error.message);
  }
});

/**
 * POST /publish - Receive content from publishers and distribute to subscribers
 *
 * Expected:
 * - Query param or body: hub.topic (or hub.url for legacy)
 * - Body: The feed content to distribute
 */
app.post("/publish", async (req, res) => {
  // Support both query param and form body for topic
  const topic =
    req.query["hub.topic"] ||
    req.query["hub.url"] ||
    req.body?.["hub.topic"] ||
    req.body?.["hub.url"];

  console.log("\n>>> Publish request for topic:", topic);

  if (!topic) {
    console.log("<<< ERROR: No topic specified");
    return res.status(400).send("Missing hub.topic or hub.url parameter");
  }

  const topicSubs = subscriptions.get(topic) || [];
  console.log(`>>> Found ${topicSubs.length} subscribers`);

  if (topicSubs.length === 0) {
    return res.status(200).send("No subscribers for this topic");
  }

  // Fetch the actual content from the topic URL
  console.log(">>> Fetching content from topic URL...");

  let content;
  let contentType;

  try {
    const feedResponse = await fetch(topic);
    content = await feedResponse.text();
    contentType = feedResponse.headers.get("content-type") || "application/atom+xml";
    console.log(">>> Fetched content:", content.length, "bytes, type:", contentType);
  } catch (error) {
    console.log("<<< ERROR fetching topic content:", error.message);
    return res.status(500).send("Failed to fetch topic content: " + error.message);
  }

  // Distribute to all subscribers
  for (const sub of topicSubs) {
    console.log(`\n>>> Distributing to subscriber: ${sub.callback}`);

    // Sign the content if subscriber provided a secret
    let signature = null;
    if (sub.secret) {
      const hmac = crypto.createHmac("sha256", sub.secret);
      hmac.update(content);
      signature = "sha256=" + hmac.digest("hex");
      console.log("  Signature:", signature);
    }

    try {
      const headers = {
        "Content-Type": contentType,
        "User-Agent": "WebSub-Test-Hub/1.0",
        Link: `<${sub.topic}>; rel="self", <http://localhost:${PORT}/hub>; rel="hub"`,
      };

      if (signature) {
        headers["X-Hub-Signature"] = signature;
      }

      console.log("  Headers:", JSON.stringify(headers, null, 4));

      const distributeResponse = await fetch(sub.callback, {
        method: "POST",
        headers,
        body: content,
      });

      console.log("  Response status:", distributeResponse.status);
      const responseBody = await distributeResponse.text();
      console.log("  Response body:", responseBody.slice(0, 200));
    } catch (error) {
      console.log("  ERROR distributing:", error.message);
    }
  }

  res.status(200).send(`Distributed to ${topicSubs.length} subscribers`);
});

/**
 * GET /status - Show current subscriptions
 */
app.get("/status", (req, res) => {
  const status = {};
  for (const [topic, subs] of subscriptions) {
    status[topic] = subs.map((s) => ({
      callback: s.callback,
      state: s.state,
      expiresAt: s.expiresAt,
      hasSecret: !!s.secret,
    }));
  }
  res.json(status);
});

/**
 * GET /subscriptions - List all subscriptions (alias for status)
 */
app.get("/subscriptions", (req, res) => {
  const allSubs = [];
  for (const [topic, subs] of subscriptions) {
    for (const sub of subs) {
      allSubs.push({
        topic,
        callback: sub.callback,
        state: sub.state,
        expiresAt: sub.expiresAt,
        hasSecret: !!sub.secret,
      });
    }
  }
  res.json(allSubs);
});

// Start the hub
app.listen(PORT, () => {
  console.log("=".repeat(80));
  console.log(`WebSub Test Hub running on http://localhost:${PORT}`);
  console.log("=".repeat(80));
  console.log("\nEndpoints:");
  console.log(`  POST http://localhost:${PORT}/hub       - Subscribe/unsubscribe`);
  console.log(`  POST http://localhost:${PORT}/publish   - Trigger content distribution`);
  console.log(`  GET  http://localhost:${PORT}/status    - View subscriptions`);
  console.log("\n" + "=".repeat(80));
});

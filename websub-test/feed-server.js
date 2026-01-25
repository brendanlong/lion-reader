/**
 * Mock Feed Server for WebSub testing.
 *
 * Serves an Atom feed that points to our local WebSub hub.
 * The feed can be updated dynamically to test content distribution.
 */

import express from "express";
import crypto from "crypto";

const app = express();
const PORT = process.env.FEED_PORT || 9001;
const HUB_URL = process.env.HUB_URL || "http://localhost:9000/hub";

// Store entries that can be dynamically added
let entries = [];
let entryCounter = 0;

// Detailed request logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  console.log("  Headers:", JSON.stringify(req.headers, null, 2));
  next();
});

/**
 * Add a new entry to the feed
 */
function addEntry(title, content) {
  entryCounter++;
  const id = `urn:uuid:${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  entries.unshift({
    id,
    title: title || `Test Entry ${entryCounter}`,
    content: content || `This is test entry number ${entryCounter}, created at ${now}`,
    published: now,
    updated: now,
    author: "Test Author",
    link: `http://localhost:${PORT}/entry/${entryCounter}`,
  });

  console.log(`>>> Added entry: ${entries[0].title}`);
  return entries[0];
}

// Add an initial entry
addEntry("Initial Test Entry", "This is the first entry in the test feed.");

/**
 * Generate Atom feed XML
 */
function generateFeed() {
  const feedUrl = `http://localhost:${PORT}/feed.atom`;
  const now = new Date().toISOString();

  let entriesXml = entries
    .map(
      (entry) => `
    <entry>
      <id>${escapeXml(entry.id)}</id>
      <title>${escapeXml(entry.title)}</title>
      <link href="${escapeXml(entry.link)}" rel="alternate" type="text/html"/>
      <published>${entry.published}</published>
      <updated>${entry.updated}</updated>
      <author>
        <name>${escapeXml(entry.author)}</name>
      </author>
      <content type="html">${escapeXml(entry.content)}</content>
    </entry>
  `
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${escapeXml(feedUrl)}</id>
  <title>WebSub Test Feed</title>
  <subtitle>A test feed for debugging Lion Reader's WebSub implementation</subtitle>
  <link href="${escapeXml(feedUrl)}" rel="self" type="application/atom+xml"/>
  <link href="${escapeXml(HUB_URL)}" rel="hub"/>
  <link href="http://localhost:${PORT}/" rel="alternate" type="text/html"/>
  <updated>${now}</updated>
  <author>
    <name>WebSub Test</name>
  </author>
  ${entriesXml}
</feed>`;
}

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * GET /feed.atom - Serve the Atom feed
 */
app.get("/feed.atom", (req, res) => {
  console.log(">>> Serving Atom feed");
  console.log(`>>> Hub URL: ${HUB_URL}`);
  console.log(`>>> Entries: ${entries.length}`);

  const feed = generateFeed();
  res.set({
    "Content-Type": "application/atom+xml; charset=utf-8",
    Link: `<${HUB_URL}>; rel="hub", <http://localhost:${PORT}/feed.atom>; rel="self"`,
  });
  res.send(feed);
});

/**
 * POST /add-entry - Add a new entry to the feed
 */
app.post("/add-entry", express.json(), (req, res) => {
  const { title, content } = req.body || {};
  const entry = addEntry(title, content);
  res.json({ success: true, entry });
});

/**
 * POST /ping-hub - Notify the hub that the feed has been updated
 */
app.post("/ping-hub", async (req, res) => {
  const feedUrl = `http://localhost:${PORT}/feed.atom`;
  const publishUrl = HUB_URL.replace("/hub", "/publish");

  console.log(`>>> Pinging hub at ${publishUrl}`);
  console.log(`>>> Topic: ${feedUrl}`);

  try {
    const response = await fetch(publishUrl + `?hub.topic=${encodeURIComponent(feedUrl)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    const body = await response.text();
    console.log(`>>> Hub response: ${response.status} ${body}`);

    res.json({
      success: true,
      hubStatus: response.status,
      hubResponse: body,
    });
  } catch (error) {
    console.log(`>>> Hub ping failed: ${error.message}`);
    res.json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /update-and-ping - Add an entry and ping the hub
 */
app.post("/update-and-ping", express.json(), async (req, res) => {
  const { title, content } = req.body || {};
  const entry = addEntry(title, content);

  // Give a tiny delay, then ping
  await new Promise((r) => setTimeout(r, 100));

  const feedUrl = `http://localhost:${PORT}/feed.atom`;
  const publishUrl = HUB_URL.replace("/hub", "/publish");

  console.log(`>>> Added entry and pinging hub...`);

  try {
    const response = await fetch(publishUrl + `?hub.topic=${encodeURIComponent(feedUrl)}`, {
      method: "POST",
    });

    const body = await response.text();

    res.json({
      success: true,
      entry,
      hubStatus: response.status,
      hubResponse: body,
    });
  } catch (error) {
    res.json({
      success: false,
      entry,
      error: error.message,
    });
  }
});

/**
 * GET /status - Show feed status
 */
app.get("/status", (req, res) => {
  res.json({
    feedUrl: `http://localhost:${PORT}/feed.atom`,
    hubUrl: HUB_URL,
    entryCount: entries.length,
    entries: entries.map((e) => ({ id: e.id, title: e.title, published: e.published })),
  });
});

/**
 * GET / - Home page
 */
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head><title>WebSub Test Feed Server</title></head>
      <body>
        <h1>WebSub Test Feed Server</h1>
        <ul>
          <li><a href="/feed.atom">Atom Feed</a></li>
          <li><a href="/status">Status (JSON)</a></li>
        </ul>
        <h2>API Endpoints</h2>
        <ul>
          <li>POST /add-entry - Add a new entry (JSON body: {title, content})</li>
          <li>POST /ping-hub - Notify hub of update</li>
          <li>POST /update-and-ping - Add entry and ping hub in one call</li>
        </ul>
        <p>Hub URL: ${HUB_URL}</p>
      </body>
    </html>
  `);
});

// Start server
app.listen(PORT, () => {
  console.log("=".repeat(80));
  console.log(`Feed Server running on http://localhost:${PORT}`);
  console.log(`Feed URL: http://localhost:${PORT}/feed.atom`);
  console.log(`Hub URL: ${HUB_URL}`);
  console.log("=".repeat(80));
});

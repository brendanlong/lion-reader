import { type DemoArticle } from "./types";

const article: DemoArticle = {
  id: "auth-security",
  subscriptionId: "lion-reader",
  type: "web",
  url: null,
  title: "Authentication & Security",
  author: null,
  summary: "Sign in with email, Google, Apple, or Discord. API tokens for extensions and MCP.",
  publishedAt: new Date("2025-12-26T11:00:00Z"),
  starred: false,
  summaryHtml: `<p>Lion Reader offers <strong>multiple sign-in methods</strong> including email/password and OAuth providers (Google, Apple, Discord), with secure <strong>session management</strong> using SHA-256 hashes and Redis caching. Features include <strong>API tokens</strong> with scoped permissions, rate limiting, webhook verification, and subscription-based entry visibility to protect privacy.</p>`,
  contentHtml: `
    <h2>Authentication &amp; Security</h2>

    <p>Lion Reader takes security and privacy seriously. Whether you&rsquo;re signing in with email or OAuth, managing API tokens, or connecting AI assistants, your data is protected with industry-standard security practices.</p>

    <h3>Multiple Sign-In Methods</h3>

    <p>Choose the authentication method that works best for you:</p>

    <ul>
      <li><strong>Email and password</strong> &mdash; Traditional authentication with Argon2 password hashing, one of the most secure hashing algorithms available</li>
      <li><strong>Google OAuth</strong> &mdash; Sign in with your Google account, with optional Google Docs access for importing documents</li>
      <li><strong>Apple Sign-In</strong> &mdash; Native Apple authentication with support for private relay email addresses</li>
      <li><strong>Discord OAuth</strong> &mdash; Connect with your Discord account for quick sign-in</li>
    </ul>

    <p>All OAuth providers are optional and can be enabled or disabled per deployment. Your Lion Reader instance, your choice.</p>

    <h3>Session Management</h3>

    <ul>
      <li><strong>Secure storage</strong> &mdash; Session tokens are stored as SHA-256 hashes, never in plain text</li>
      <li><strong>Redis caching</strong> &mdash; Sessions are cached for fast validation with a 5-minute TTL</li>
      <li><strong>Active session tracking</strong> &mdash; View all your sessions with browser, platform, IP address, and last active timestamp</li>
      <li><strong>Revocation</strong> &mdash; Revoke any session instantly from the settings page</li>
    </ul>

    <h3>API Tokens</h3>

    <p>Connect external tools and scripts to your Lion Reader account with API tokens:</p>

    <ul>
      <li><strong>Scoped permissions</strong> &mdash; Tokens can be limited to specific capabilities like saved:write or mcp</li>
      <li><strong>Expiration dates</strong> &mdash; Set automatic expiration for temporary access</li>
      <li><strong>Usage tracking</strong> &mdash; See when each token was last used</li>
      <li><strong>Perfect for extensions</strong> &mdash; Use API tokens to connect browser extensions, the MCP server, or the Discord bot</li>
    </ul>

    <h3>Security Features</h3>

    <ul>
      <li><strong>Rate limiting</strong> &mdash; Per-user rate limiting via Redis token bucket prevents abuse</li>
      <li><strong>Respectful fetching</strong> &mdash; Feed fetching uses exponential backoff and respects server Cache-Control headers, Retry-After directives, and HTTP 429 responses</li>
      <li><strong>Webhook verification</strong> &mdash; Email webhooks use HMAC signature verification</li>
      <li><strong>Content sanitization</strong> &mdash; All feed content is sanitized to prevent XSS attacks</li>
      <li><strong>Invite-only mode</strong> &mdash; Deploy with invite-only registration to control access</li>
    </ul>

    <h3>Privacy Protections</h3>

    <ul>
      <li><strong>Subscription-based visibility</strong> &mdash; You only see entries fetched after you subscribed, preventing access to historical private content</li>
      <li><strong>Starred entry preservation</strong> &mdash; Entries you&rsquo;ve starred remain visible even after unsubscribing</li>
      <li><strong>Soft deletes</strong> &mdash; Unsubscribing preserves your read state and preferences for seamless resubscription</li>
      <li><strong>Your data stays yours</strong> &mdash; No ads, no data selling, no third-party analytics. Reading behavior is used only to power features like article scoring, and self-hosting gives you full control</li>
    </ul>
  `,
};

export default article;

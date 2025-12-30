# Email Newsletter Subscriptions Design

This document describes the design for email newsletter subscriptions in Lion Reader, allowing users to subscribe to email newsletters and read them alongside RSS feeds.

## Overview

Users can generate unique ingest email addresses to subscribe to newsletters. Incoming emails are processed via webhooks and appear as entries in feeds, with full support for tagging, starring, and read/unread state.

### Key Design Decisions

1. **Multiple ingest addresses**: Users can create up to 5 ingest addresses (e.g., `abc123@ingest.lionreader.com`), allowing compartmentalized subscriptions
2. **Sender-based feed grouping**: Each unique sender email creates a separate feed, avoiding duplicate feeds when the same sender emails different ingest addresses
3. **Plus codes accepted but ignored**: Emails to `token+anything@ingest...` are treated identically to `token@ingest...` (future-proofing)
4. **No sender verification**: We accept emails from any sender (newsletter providers don't support verification)
5. **Spam filtering**: Provider-level spam filtering with user option to view spam

### User Flows

**Subscribing to a newsletter:**
1. User creates an ingest address in settings
2. User subscribes to newsletter using that address
3. First email from sender creates a new feed (named after sender's display name)
4. Subsequent emails appear as entries in that feed

**Unsubscribing:**
1. User unsubscribes from feed in Lion Reader
2. System sends List-Unsubscribe email if available
3. Sender is added to blocked list
4. Future emails from sender are dropped
5. Subscription is soft-deleted (starred entries preserved)

**Deleting an ingest address:**
1. User deletes ingest address in settings
2. Future emails to that address are rejected
3. Existing feeds and entries are unaffected

---

## Architecture

### Email Flow

```
┌─────────────────────┐
│  Newsletter Sender  │
└──────────┬──────────┘
           │ email
           ▼
┌─────────────────────┐
│  Cloudflare Email   │
│  Workers            │
│  - Spam filtering   │
│  - Parse email      │
│  - POST to webhook  │
└──────────┬──────────┘
           │ POST /api/webhooks/email/cloudflare
           ▼
┌─────────────────────┐
│  Webhook Handler    │
│  - Validate token   │
│  - Normalize sender │
│  - Check blocked    │
│  - Find/create feed │
│  - Create entry     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Redis Pub/Sub      │
│  - Notify clients   │
└─────────────────────┘
```

### Provider Abstraction

The webhook endpoint is provider-specific (`/api/webhooks/email/cloudflare`), but it normalizes the email into a common format and calls shared processing logic:

```typescript
// Provider-specific webhook parses into this format
interface InboundEmail {
  to: string;           // recipient address
  from: {
    address: string;    // sender email
    name?: string;      // sender display name
  };
  subject: string;
  messageId: string;    // Message-ID header (used as entry guid)
  html?: string;
  text?: string;
  headers: {
    listUnsubscribe?: string;      // List-Unsubscribe header
    listUnsubscribePost?: string;  // List-Unsubscribe-Post header
  };
  spamScore?: number;   // provider's spam score
  isSpam?: boolean;     // provider's spam verdict
}

// Shared processing logic
async function processInboundEmail(email: InboundEmail): Promise<void>;
```

This allows adding new providers (Postmark, Mailgun, etc.) by implementing only the webhook parsing.

---

## Database Schema

### New Tables

```sql
-- ============================================================================
-- INGEST ADDRESSES
-- ============================================================================

CREATE TABLE ingest_addresses (
  id uuid PRIMARY KEY DEFAULT gen_uuidv7(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,

  token text UNIQUE NOT NULL,  -- random token, email = {token}@ingest.lionreader.com
  label text,                   -- optional user-provided name

  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,       -- soft delete, rejects future emails

  CONSTRAINT max_addresses_per_user CHECK (
    -- Enforced in application layer, not here (would need a function)
    true
  )
);

CREATE INDEX idx_ingest_addresses_user ON ingest_addresses(user_id)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_ingest_addresses_token ON ingest_addresses(token)
  WHERE deleted_at IS NULL;

-- ============================================================================
-- BLOCKED SENDERS
-- ============================================================================

CREATE TABLE blocked_senders (
  id uuid PRIMARY KEY DEFAULT gen_uuidv7(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,

  sender_email text NOT NULL,  -- normalized (lowercased, plus codes stripped)
  blocked_at timestamptz NOT NULL DEFAULT now(),

  -- Store unsubscribe info for potential retry
  list_unsubscribe_mailto text,
  unsubscribe_sent_at timestamptz,

  UNIQUE(user_id, sender_email)
);

CREATE INDEX idx_blocked_senders_user ON blocked_senders(user_id);
```

### Schema Changes to Existing Tables

```sql
-- ============================================================================
-- FEEDS: Add user_id for email feeds
-- ============================================================================

ALTER TABLE feeds ADD COLUMN user_id uuid REFERENCES users ON DELETE CASCADE;

-- Email feeds require user_id, other feeds must not have it
ALTER TABLE feeds ADD CONSTRAINT feed_type_user_id CHECK (
  (type = 'email') = (user_id IS NOT NULL)
);

-- Unique constraint for email feeds: one feed per (user, sender)
CREATE UNIQUE INDEX idx_feeds_email_user_sender
  ON feeds(user_id, email_sender_pattern)
  WHERE type = 'email';

-- ============================================================================
-- ENTRIES: Add spam tracking and email metadata
-- ============================================================================

ALTER TABLE entries ADD COLUMN spam_score real;
ALTER TABLE entries ADD COLUMN is_spam boolean NOT NULL DEFAULT false;

-- List-Unsubscribe info (stored on entries, used when unsubscribing)
ALTER TABLE entries ADD COLUMN list_unsubscribe_mailto text;
ALTER TABLE entries ADD COLUMN list_unsubscribe_https text;
ALTER TABLE entries ADD COLUMN list_unsubscribe_post boolean;  -- true if one-click supported

CREATE INDEX idx_entries_spam ON entries(feed_id, is_spam) WHERE is_spam;

-- ============================================================================
-- USERS: Add spam visibility preference
-- ============================================================================

ALTER TABLE users ADD COLUMN show_spam boolean NOT NULL DEFAULT false;
```

### Email Sender Normalization

Sender emails are normalized before storage and comparison:

```typescript
function normalizeSenderEmail(email: string): string {
  const [localPart, domain] = email.toLowerCase().split('@');

  // Strip plus codes (newsletter+tracking@example.com → newsletter@example.com)
  const normalizedLocal = localPart.split('+')[0];

  return `${normalizedLocal}@${domain}`;
}
```

---

## API Endpoints

### Ingest Addresses

```typescript
// tRPC router: ingestAddresses

ingestAddresses.list        GET    /v1/ingest-addresses
// Returns: { addresses: IngestAddress[] }

ingestAddresses.create      POST   /v1/ingest-addresses
// Input: { label?: string }
// Returns: { address: IngestAddress }
// Errors: MAX_ADDRESSES_REACHED (limit 5)

ingestAddresses.update      PATCH  /v1/ingest-addresses/:id
// Input: { label?: string }
// Returns: { address: IngestAddress }

ingestAddresses.delete      DELETE /v1/ingest-addresses/:id
// Returns: {}
// Note: Soft delete, sets deleted_at
```

### Blocked Senders

```typescript
// tRPC router: blockedSenders

blockedSenders.list         GET    /v1/blocked-senders
// Returns: { senders: BlockedSender[] }

blockedSenders.unblock      DELETE /v1/blocked-senders/:id
// Returns: {}
// Note: Removes from blocked list, future emails accepted again
```

### Subscription Changes

The existing `subscriptions.delete` endpoint is extended for email feeds:

```typescript
subscriptions.delete        DELETE /v1/subscriptions/:id
// For email feeds:
//   1. Send List-Unsubscribe email if available
//   2. Add sender to blocked_senders
//   3. Soft-delete subscription
// For RSS feeds:
//   1. Soft-delete subscription (existing behavior)
```

---

## Webhook Processing

### Cloudflare Email Worker

The Cloudflare Email Worker receives emails and forwards them to our webhook:

```typescript
// cloudflare-worker/email-worker.ts
export default {
  async email(message: EmailMessage, env: Env): Promise<void> {
    const email = await parseEmail(message);

    await fetch(`${env.API_URL}/api/webhooks/email/cloudflare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': env.WEBHOOK_SECRET,
      },
      body: JSON.stringify(email),
    });
  }
};
```

### Webhook Endpoint

```typescript
// app/api/webhooks/email/cloudflare/route.ts

export async function POST(req: Request) {
  // 1. Verify webhook secret
  const secret = req.headers.get('X-Webhook-Secret');
  if (secret !== process.env.EMAIL_WEBHOOK_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  // 2. Parse Cloudflare-specific format into InboundEmail
  const cfEmail = await req.json();
  const email = parseCloudflareEmail(cfEmail);

  // 3. Process with shared logic
  await processInboundEmail(email);

  return new Response('OK', { status: 200 });
}
```

### Email Processing Logic

```typescript
// server/email/process-inbound.ts

async function processInboundEmail(email: InboundEmail): Promise<void> {
  // 1. Extract token from recipient (strip plus codes)
  const token = extractToken(email.to);  // "abc123+ignored" → "abc123"

  // 2. Find ingest address
  const ingestAddress = await db.ingestAddresses.findByToken(token);
  if (!ingestAddress || ingestAddress.deletedAt) {
    logger.info('Email rejected: invalid or deleted ingest address', { token });
    return;  // Silently drop
  }

  const userId = ingestAddress.userId;

  // 3. Normalize sender email
  const senderEmail = normalizeSenderEmail(email.from.address);

  // 4. Check if sender is blocked
  const blocked = await db.blockedSenders.find(userId, senderEmail);
  if (blocked) {
    logger.info('Email rejected: sender blocked', { senderEmail, userId });
    return;  // Silently drop
  }

  // 5. Find or create feed for this sender
  let feed = await db.feeds.findEmailFeed(userId, senderEmail);

  if (!feed) {
    feed = await db.feeds.create({
      type: 'email',
      userId,
      emailSenderPattern: senderEmail,
      title: email.from.name || senderEmail,  // Default to display name
    });

    // Auto-create subscription
    await db.subscriptions.create({
      userId,
      feedId: feed.id,
      subscribedAt: new Date(),
    });
  }

  // 6. Check for duplicate (same Message-ID)
  const existingEntry = await db.entries.findByGuid(feed.id, email.messageId);
  if (existingEntry) {
    logger.info('Email rejected: duplicate Message-ID', { messageId: email.messageId });
    return;
  }

  // 7. Create entry
  const content = email.html || email.text || '';
  const contentHash = hash(content + email.subject);

  await db.entries.create({
    feedId: feed.id,
    guid: email.messageId,
    title: email.subject,
    contentOriginal: content,
    contentCleaned: content,  // TODO: sanitize HTML
    summary: truncate(stripHtml(content), 300),
    emailFrom: email.from.address,
    emailSubject: email.subject,
    publishedAt: new Date(),
    fetchedAt: new Date(),
    contentHash,
    spamScore: email.spamScore,
    isSpam: email.isSpam ?? false,
    listUnsubscribeMailto: parseListUnsubscribeMailto(email.headers.listUnsubscribe),
    listUnsubscribeHttps: parseListUnsubscribeHttps(email.headers.listUnsubscribe),
    listUnsubscribePost: email.headers.listUnsubscribePost?.includes('One-Click') ?? false,
  });

  // 8. Publish real-time event
  await redis.publish(`feed:${feed.id}:events`, JSON.stringify({
    type: 'new_entry',
    feedId: feed.id,
  }));

  logger.info('Email processed successfully', {
    feedId: feed.id,
    senderEmail,
    messageId: email.messageId,
  });
}
```

---

## Unsubscribe Flow

When a user unsubscribes from an email feed:

```typescript
// server/trpc/routers/subscriptions.ts

async function deleteSubscription(subscriptionId: string, userId: string) {
  const subscription = await db.subscriptions.findById(subscriptionId);
  const feed = await db.feeds.findById(subscription.feedId);

  if (feed.type === 'email') {
    // 1. Try to send List-Unsubscribe email
    await attemptUnsubscribe(feed, userId);

    // 2. Block sender
    await db.blockedSenders.create({
      userId,
      senderEmail: feed.emailSenderPattern,
      blockedAt: new Date(),
    });
  }

  // 3. Soft-delete subscription (same for all feed types)
  await db.subscriptions.update(subscriptionId, {
    unsubscribedAt: new Date(),
  });
}

async function attemptUnsubscribe(feed: Feed, userId: string) {
  // Get most recent entry with unsubscribe info
  const entry = await db.entries.findLatestWithUnsubscribe(feed.id);
  if (!entry) return;

  // Try mailto: first (simple and reliable)
  if (entry.listUnsubscribeMailto) {
    await sendUnsubscribeEmail(entry.listUnsubscribeMailto);
    return;
  }

  // Try https: only if one-click POST is supported
  if (entry.listUnsubscribeHttps && entry.listUnsubscribePost) {
    await sendUnsubscribePost(entry.listUnsubscribeHttps);
    return;
  }

  // No unsubscribe mechanism available - just block
  logger.info('No List-Unsubscribe available', { feedId: feed.id });
}

async function sendUnsubscribeEmail(mailto: string) {
  // Parse mailto: URL
  // Format: mailto:unsubscribe@example.com?subject=Unsubscribe
  const url = new URL(mailto);
  const to = url.pathname;
  const subject = url.searchParams.get('subject') || 'Unsubscribe';

  // Send via email provider
  await emailProvider.send({
    to,
    subject,
    text: 'Please unsubscribe this address from your mailing list.',
  });
}

async function sendUnsubscribePost(url: string) {
  // RFC 8058 one-click unsubscribe
  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'List-Unsubscribe=One-Click',
  });
}
```

---

## Spam Handling

### Provider-Level Filtering

Cloudflare Email Workers can be configured to reject obvious spam before it reaches our webhook. Emails that pass initial filtering but have elevated spam scores are stored with `is_spam = true`.

### Query Filtering

```typescript
// Entries query respects user's spam preference
const entries = await db.entries.list({
  feedId,
  showSpam: user.showSpam,  // Defaults to false
});

// SQL: WHERE (NOT is_spam OR :showSpam)
```

### User Settings

Users can toggle spam visibility in settings:

```typescript
users.updatePreferences   PATCH  /v1/users/me/preferences
// Input: { showSpam?: boolean }
```

---

## Security Considerations

### Webhook Authentication

- Cloudflare webhook includes a shared secret in headers
- Secret stored in environment variable, verified on every request

### Email Content Sanitization

- HTML content is sanitized before storage (remove scripts, dangerous attributes)
- Same sanitization as RSS feed content

### Rate Limiting

- Per-ingest-address rate limiting to prevent abuse
- Suggested: 100 emails/hour per ingest address
- Excess emails are dropped with a warning logged

### Token Security

- Ingest tokens are 16+ random bytes, base64url encoded
- Tokens are not derived from user ID (can't be guessed)
- Deleted tokens are kept in database to prevent reuse

---

## Future Enhancements

1. **Outbound email**: Email verification, password reset, digest newsletters
2. **Plus code routing**: Use plus codes for automatic tagging or folder assignment
3. **Sender aliases**: Merge multiple sender addresses into one feed
4. **Import existing emails**: Forward from Gmail/Outlook with historical import
5. **Custom domains**: Allow users to use their own domain for ingest addresses

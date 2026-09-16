# Mailgun — the inbound newsletter path. Receive-only: nothing in the codebase
# sends mail, so the sending-side settings exist to pin them, not because we use
# them. The account's auto-created sandbox domain is not managed here.

resource "mailgun_domain" "app" {
  name   = var.mail_domain
  region = "us"

  # Load-bearing. Mailgun only accepts mail for domains registered on the
  # account, and in.app.lionreader.com is not one — it is accepted because it is
  # a subdomain of this one. Off, every newsletter is silently rejected.
  wildcard = true

  # The app allowlists senders per ingest address, and `tag` would only add a
  # header we don't read.
  spam_action = "disabled"

  # Nothing to track, since we don't send. This is why the `email.app` CNAME in
  # cloudflare.tf is inert — Mailgun creates that record either way.
  open_tracking  = false
  click_tracking = false
  web_scheme     = "http"

  # Our DKIM record lives in cloudflare.tf with the rest of the zone.
  use_automatic_sender_security = false

  # dkim_selector (`krs`), dkim_key_size and force_dkim_authority are omitted on
  # purpose: the provider never reads them back, so declaring the real values
  # reads as a change to three RequiresReplace attributes.

  lifecycle {
    prevent_destroy = true
  }
}

# `forward()` is how inbound mail is delivered. Mailgun signs the POST with the
# HTTP webhook signing key, which the app verifies as
# MAILGUN_WEBHOOK_SIGNING_KEY. There are no `mailgun_webhook` resources because
# those subscribe to sending events, and we don't send.
resource "mailgun_route" "newsletter_ingest" {
  priority    = 0
  description = "Inbox newsletters"

  # Must stay in sync with INGEST_EMAIL_DOMAIN in ../fly.toml — the app hands
  # users addresses at that domain and this is what makes Mailgun accept them.
  expression = "match_recipient(\".*@${var.ingest_email_domain}\")"

  # `store()` keeps a copy retrievable from Mailgun for the retention window,
  # which is what makes a failed forward diagnosable after the fact.
  actions = [
    "forward(\"https://${var.domain}/api/webhooks/email/mailgun\")",
    "store()",
  ]
}

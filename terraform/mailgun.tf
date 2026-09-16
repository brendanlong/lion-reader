# ---------------------------------------------------------------------------
# Mailgun — the inbound newsletter path
#
# This describes the EXISTING setup and is adopted via the `import` blocks in
# imports.tf. Nothing here creates infrastructure.
#
# Mailgun is receive-only for us: there is no MAILGUN_API_KEY in the app's
# secrets and nothing in the codebase sends mail. The whole account exists to
# land newsletter mail on /api/webhooks/email/mailgun, so the sending-side
# knobs below are declared to pin them, not because we use them.
#
# ⚠️  `wildcard` is RequiresReplace and defaults to `false`, while the live
#     domain has it `true`. Leaving it undeclared does not "adopt" the live
#     value — it plans a REPLACE, which deletes the Mailgun domain and
#     regenerates its DKIM keypair, breaking inbound mail until new DNS
#     propagates. It is the one attribute here whose default differs from
#     live, and the reason `prevent_destroy` is set. Every value below was read
#     from the live API, not guessed; the first `terraform plan` MUST come out
#     with no changes.
# ---------------------------------------------------------------------------

# The account's auto-created sandbox domain is deliberately not managed here:
# it is Mailgun's, we never send through it, and it cannot be recreated.

resource "mailgun_domain" "app" {
  name   = var.mail_domain
  region = "us"

  # Wildcard is what makes the ingest subdomain work. Mailgun only accepts mail
  # for domains registered on the account, and in.app.lionreader.com is NOT
  # registered — it is accepted because it is a subdomain of this one. Turning
  # this off silently rejects every newsletter. See the warning above.
  wildcard = true

  # Inbound spam filtering off: the app does its own sender allowlisting per
  # ingest address, and a `tag` action would only add a header we don't read.
  spam_action = "disabled"

  # We don't send, so there is nothing to track. These being off is why the
  # `email.app` CNAME in cloudflare.tf is inert — Mailgun creates that record
  # as part of domain setup whether or not tracking is ever enabled.
  open_tracking  = false
  click_tracking = false
  web_scheme     = "http"

  # Mailgun-managed DKIM keys and DNS. Off: our DKIM record is in cloudflare.tf,
  # where the rest of the zone lives.
  use_automatic_sender_security = false

  # dkim_selector, dkim_key_size, force_dkim_authority and smtp_password are
  # deliberately absent. The provider never refreshes them from the API (they
  # are write-only inputs — see applyDomainResponse in the provider), so after
  # an import they are null in state. Declaring the live values (selector `krs`,
  # 1024-bit) would therefore read as a null → value diff, and all three are
  # RequiresReplace: it would destroy the domain rather than record a fact.

  lifecycle {
    prevent_destroy = true
  }
}

# The only route. `forward()` is the delivery mechanism for inbound mail —
# Mailgun signs the POST with the HTTP webhook signing key, which the app
# verifies as MAILGUN_WEBHOOK_SIGNING_KEY.
#
# There are deliberately no `mailgun_webhook` resources: those subscribe to
# *sending* events (delivered/opened/bounced), and we don't send. The account
# has none configured.
resource "mailgun_route" "newsletter_ingest" {
  priority    = 0
  description = "Inbox newsletters"

  # Must stay in sync with INGEST_EMAIL_DOMAIN in ../fly.toml: the app hands
  # users addresses at that domain, and this is what makes Mailgun accept them.
  # Verbatim from the live route — the unescaped dots are regex-any, which is
  # harmless here (no other domain resolves to this account) but means editing
  # this string is a live change to the only path inbound mail takes.
  expression = "match_recipient(\".*@${var.ingest_email_domain}\")"

  # Ordered list, and the order is the live one. `store()` keeps a copy
  # retrievable from Mailgun for the retention window, which is what makes a
  # failed forward diagnosable after the fact.
  actions = [
    "forward(\"https://${var.domain}/api/webhooks/email/mailgun\")",
    "store()",
  ]
}

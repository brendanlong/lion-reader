# Cloudflare — the whole lionreader.com zone. Every record lives here, including
# the mail records for both Mailgun (newsletter ingest) and Fastmail (mailboxes
# at the apex).
#
# `proxied = false` on every proxyable record (A / AAAA / CNAME) is an invariant,
# not a default — see ../docs/DEPLOYMENT.md. TXT and MX cannot be proxied, so
# they carry no such field. Nothing in this zone is proxied at all — it serves
# the app directly at the apex — so there is no apex redirect and no ruleset.
#
# TXT content is written quoted, as Cloudflare stores it. Unquoted values
# resolve the same but are flagged with a warning in the dashboard.

resource "cloudflare_zone" "lionreader" {
  account = {
    id = var.cloudflare_account_id
  }
  name = var.domain
  type = "full"
}

# --- Apex → Fly -------------------------------------------------------------
# Must stay DNS-only. Fly accepts any one of an AAAA record pointing at the app,
# an _acme-challenge CNAME, or a _fly-ownership TXT as proof of ownership. This
# zone has neither of the latter two, so the AAAA below is the only thing
# keeping the certificate renewing — proxying it would break renewal outright.
resource "cloudflare_dns_record" "apex_a" {
  zone_id = cloudflare_zone.lionreader.id
  name    = "@"
  type    = "A"
  content = var.fly_ipv4
  proxied = false
  ttl     = 86400
  comment = "Fly app. Never proxy: see docs/DEPLOYMENT.md"
}

resource "cloudflare_dns_record" "apex_aaaa" {
  zone_id = cloudflare_zone.lionreader.id
  name    = "@"
  type    = "AAAA"
  content = var.fly_ipv6
  proxied = false
  ttl     = 86400
  comment = "Fly app + ACME ownership proof. Never proxy: see docs/DEPLOYMENT.md"
}

# --- CDN → Bunny ------------------------------------------------------------
# DNS-only, and this must stay a real CNAME answer. Bunny steers to a nearby POP
# via GeoDNS — its nameservers honor EDNS Client Subnet and answer with a 35s
# TTL — so the resolution has to happen at the client's resolver. Do NOT enable
# "Flatten all CNAMEs" zone-wide: that resolves b-cdn.net from Cloudflare's
# vantage point and pins every visitor to one edge. (Apex-only flattening, the
# default, is fine — our apex is an A record, not a CNAME.)
resource "cloudflare_dns_record" "cdn" {
  zone_id = cloudflare_zone.lionreader.id
  name    = "cdn"
  type    = "CNAME"
  content = var.bunny_cdn_hostname
  proxied = false
  ttl     = 86400
  comment = "Bunny pull zone. Never proxy or flatten: see docs/DEPLOYMENT.md"
}

# --- Announcements → GitHub Pages -------------------------------------------
# The default ANNOUNCEMENT_FEED_URL origin. DNS-only: proxying a GitHub Pages
# CNAME breaks Pages' own certificate renewal, silently, weeks later.
resource "cloudflare_dns_record" "announcements" {
  zone_id = cloudflare_zone.lionreader.id
  name    = "announcements"
  type    = "CNAME"
  content = "brendanlong.github.io"
  proxied = false
  ttl     = 86400
  comment = "GitHub Pages. Never proxy: breaks Pages cert renewal"
}

# --- Newsletter ingest host -------------------------------------------------
# Same Fly app. This name also carries the inbound MX records, declared with the
# rest of the mail records below.
resource "cloudflare_dns_record" "ingest_a" {
  zone_id = cloudflare_zone.lionreader.id
  name    = "in.app"
  type    = "A"
  content = var.fly_ipv4
  proxied = false
  ttl     = 86400
  comment = "Fly app (INGEST_EMAIL_DOMAIN). Never proxy"
}

resource "cloudflare_dns_record" "ingest_aaaa" {
  zone_id = cloudflare_zone.lionreader.id
  name    = "in.app"
  type    = "AAAA"
  content = var.fly_ipv6
  proxied = false
  ttl     = 86400
  comment = "Fly app (INGEST_EMAIL_DOMAIN). Never proxy"
}

# --- Mailgun tracking host --------------------------------------------------
# Inert — tracking is off (mailgun.tf) and we send no mail for it to rewrite.
# Kept so the Mailgun domain stays fully verified rather than partly configured.
resource "cloudflare_dns_record" "mailgun_tracking" {
  zone_id = cloudflare_zone.lionreader.id
  name    = "email.app"
  type    = "CNAME"
  content = "mailgun.org"
  proxied = false
  ttl     = 86400
  comment = "Mailgun tracking host (unused). Never proxy"
}

# --- Mail (Mailgun) and domain verification — TXT and MX --------------------
# The Mailgun side these point at is in mailgun.tf. The MX host is NOT itself a
# registered Mailgun domain — it works because that domain has `wildcard` set.

resource "cloudflare_dns_record" "spf" {
  zone_id = cloudflare_zone.lionreader.id
  name    = "app"
  type    = "TXT"
  content = "\"v=spf1 include:mailgun.org ~all\""
  ttl     = 300
  comment = "Mailgun SPF"
}

resource "cloudflare_dns_record" "dkim" {
  zone_id = cloudflare_zone.lionreader.id
  name    = "krs._domainkey.app"
  type    = "TXT"
  content = "\"k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDwjmL/6JMMVYdLu30HDMoAe/tt75hwN20W5bS6eRBUoEMwBIPPilwA+G8PzWDeMHUkAjzBhuDk0S2g8NVC/PqaU5oFRbPVmU0REq75ZyraAyUfPVDT6j/asvnA4LyJzqBWaAt183AK4VtOpS3KNr8VyI5jzyFbVDO6IAzMj8zF2wIDAQAB\""
  ttl     = 300
  comment = "Mailgun DKIM (selector krs)"
}

resource "cloudflare_dns_record" "dmarc" {
  zone_id = cloudflare_zone.lionreader.id
  name    = "_dmarc.app"
  type    = "TXT"
  content = "\"v=DMARC1; p=none; pct=100; fo=1; ri=3600; rua=mailto:c7650f54@dmarc.mailgun.org,mailto:eb182582@inbox.ondmarc.com; ruf=mailto:c7650f54@dmarc.mailgun.org,mailto:eb182582@inbox.ondmarc.com;\""
  ttl     = 300
  comment = "DMARC, reporting to Mailgun + OnDMARC"
}

resource "cloudflare_dns_record" "ingest_mx_a" {
  zone_id  = cloudflare_zone.lionreader.id
  name     = "in.app"
  type     = "MX"
  content  = "mxa.mailgun.org"
  priority = 10
  ttl      = 86400
  comment  = "Newsletter ingest (INGEST_EMAIL_DOMAIN)"
}

resource "cloudflare_dns_record" "ingest_mx_b" {
  zone_id  = cloudflare_zone.lionreader.id
  name     = "in.app"
  type     = "MX"
  content  = "mxb.mailgun.org"
  priority = 10
  ttl      = 86400
  comment  = "Newsletter ingest (INGEST_EMAIL_DOMAIN)"
}

# --- Mailboxes at the apex (Fastmail) ---------------------------------------
# Separate from newsletter ingest: that lives on in.app (Mailgun, above), so
# these records can change without touching it, and vice versa.

resource "cloudflare_dns_record" "fastmail_mx_1" {
  zone_id  = cloudflare_zone.lionreader.id
  name     = "@"
  type     = "MX"
  content  = "us1-smtp.messagingengine.com"
  priority = 10
  ttl      = 300
  comment  = "Fastmail"
}

resource "cloudflare_dns_record" "fastmail_mx_2" {
  zone_id  = cloudflare_zone.lionreader.id
  name     = "@"
  type     = "MX"
  content  = "us2-smtp.messagingengine.com"
  priority = 20
  ttl      = 300
  comment  = "Fastmail"
}

resource "cloudflare_dns_record" "fastmail_spf" {
  zone_id = cloudflare_zone.lionreader.id
  name    = "@"
  type    = "TXT"
  content = "\"v=spf1 include:spf.messagingengine.com ?all\""
  ttl     = 300
  comment = "Fastmail SPF"
}

resource "cloudflare_dns_record" "fastmail_dkim" {
  for_each = toset(["fm1", "fm2", "fm3"])

  zone_id = cloudflare_zone.lionreader.id
  name    = "${each.key}._domainkey"
  type    = "CNAME"
  content = "${each.key}.${var.domain}.dkim.fmhosted.com"
  proxied = false
  ttl     = 300
  comment = "Fastmail DKIM. Never proxy"
}

resource "cloudflare_dns_record" "google_verification" {
  zone_id = cloudflare_zone.lionreader.id
  name    = "@"
  type    = "TXT"
  content = "\"google-site-verification=VaZJWXsqI7zVXMOAPZnWO1gqc7vbMTwUEyaqjhd-Js8\""
  ttl     = 300
  comment = "Google Search Console"
}

resource "cloudflare_dns_record" "discord_verification" {
  zone_id = cloudflare_zone.lionreader.id
  name    = "_discord"
  type    = "TXT"
  content = "\"dh=a1c8abb6b4d9e85506d748e1ef7331dcbb5232ac\""
  ttl     = 3600
  comment = "Discord domain verification"
}

# ---------------------------------------------------------------------------
# Cloudflare — zone and the proxyable DNS records
#
# Terraform owns every A / AAAA / CNAME record, because those are the types
# Cloudflare can proxy, and `proxied = false` on each of them is an invariant
# worth enforcing in code rather than in a dashboard (see docs/DEPLOYMENT.md).
#
# TXT and MX records are intentionally NOT here — Cloudflare cannot proxy them,
# so there is no grey-cloud decision to get wrong, and they are mail config that
# changes on Mailgun's schedule rather than ours. They are imported once from
# cloudflare-import.zone and managed in the dashboard. The provider only touches
# records it declares, so partial-zone management is safe.
#
# There is no apex redirect and no ruleset here: unlike brendanlong.com, this
# zone serves the app directly at the apex, so nothing is proxied at all.
# ---------------------------------------------------------------------------

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
# Same Fly app. The MX records for this name live in the dashboard (imported
# from cloudflare-import.zone) — only the proxyable types are managed here.
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

# --- Mailgun click/open tracking --------------------------------------------
resource "cloudflare_dns_record" "mailgun_tracking" {
  zone_id = cloudflare_zone.lionreader.id
  name    = "email.app"
  type    = "CNAME"
  content = "mailgun.org"
  proxied = false
  ttl     = 86400
  comment = "Mailgun tracking. Never proxy: breaks click/open tracking"
}

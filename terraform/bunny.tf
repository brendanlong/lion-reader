# ---------------------------------------------------------------------------
# Bunny CDN — the pull zone fronting the Fly app
#
# This describes the EXISTING setup and is adopted via the `import` blocks in
# imports.tf. Nothing here creates infrastructure.
#
# Unlike brendanlong.com (a static site on a StorageZone origin), this pull zone
# has the running app as its origin and wraps the WHOLE site, honoring origin
# Cache-Control. That makes a behaviour-neutral import more delicate:
#
# ⚠️  Pull-zone attributes are NOT simply adopted on import. Many carry static
#     provider defaults, so leaving one undeclared ASSERTS that default and
#     silently changes the live zone on apply. The specific hazard here is
#     cache_expiration_time: the live value is -1 ("no override — obey origin
#     Cache-Control"), which is what keeps HTML/RSC off the edge. Setting it to
#     a positive number would start CDN-caching build-coupled documents, which
#     is exactly the version-skew failure documented in docs/DEPLOYMENT.md
#     ("Why HTML and RSC are not CDN-cached").
#
#     Every value below was read from the live API (GET /pullzone/6171160), not
#     guessed. Do not "tidy" them. The first `terraform plan` MUST come out with
#     no changes — if it proposes any, a field is wrong; reconcile it rather
#     than applying.
# ---------------------------------------------------------------------------

resource "bunnynet_pullzone" "lionreader" {
  name = "lionreader"

  origin {
    # Live: OriginType 0 = OriginUrl, StorageZoneId 0 (no storage zone).
    type = "OriginUrl"
    url  = "https://lion-reader.fly.dev"
  }

  # Live: Type 0 = Standard. Only the US geo zone is enabled — EnableGeoZoneEU,
  # ASIA, SA and AF are all false on the live zone. Declaring the other four
  # would ENABLE them (a coverage and billing change), so this stays US-only
  # until that is a deliberate decision. See the README note.
  routing {
    tier  = "Standard"
    zones = ["US"]
  }

  # Live: CacheControlMaxAgeOverride -1. See the warning above before touching.
  cache_expiration_time = -1

  # Live: AccessControlOriginHeaderExtensions. These are the CORS-enabled
  # extensions that make cross-origin font loads work (docs/DEPLOYMENT.md).
  cors_extensions = [
    "css", "eot", "gif", "jpeg", "jpg", "js", "mp3", "mp4", "mpeg",
    "png", "svg", "ttf", "webm", "webp", "woff", "woff2",
  ]

  lifecycle {
    prevent_destroy = true
  }
}

# The custom hostname the Cloudflare `cdn` CNAME points at. The system hostname
# (lionreader.b-cdn.net) is created by Bunny and deliberately not managed here.
resource "bunnynet_pullzone_hostname" "cdn" {
  pullzone    = bunnynet_pullzone.lionreader.id
  name        = "cdn.lionreader.com"
  tls_enabled = true  # live: HasCertificate true
  force_ssl   = false # live: ForceSSL false
}

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

  # US-only on purpose: serving from EU POPs would pull us into EU data-protection
  # obligations we don't want, and essentially all users are in the US anyway.
  # Adding a zone here is a legal decision before it is a performance one.
  # Live: Type 0 = Standard, RoutingFilters ["all"], only EnableGeoZoneUS true.
  routing {
    tier    = "Standard"
    zones   = ["US"]
    filters = ["all"]
  }

  # Live: CacheControlMaxAgeOverride -1 and CacheControlPublicMaxAgeOverride -1.
  # See the warning above before touching either.
  cache_expiration_time         = -1
  cache_expiration_time_browser = -1

  # Live: QueryStringVaryParameters. These are load-bearing — `_rsc` and `dpl`
  # are what keep RSC payloads and post-deploy assets from colliding in the edge
  # cache (../docs/DEPLOYMENT.md, "Why HTML and RSC are not CDN-cached"). An
  # empty default here would silently merge them into one cache entry.
  # cache_vary is the master switch; cache_vary_querystring is only the parameter
  # list it applies. Declaring the list without "querystring" here would leave the
  # list in place but stop it being used — the cache key would lose _rsc and dpl
  # entirely, which is the collision this setting exists to prevent.
  cache_vary             = ["querystring"]
  cache_vary_querystring = ["entry", "_rsc", "v", "dpl"]
  sort_querystring       = true

  # Live: DisableCookies true.
  strip_cookies = true

  # Live: EnableAccessControlOriginHeader true + AccessControlOriginHeaderExtensions.
  # This is what makes cross-origin font loads work (../docs/DEPLOYMENT.md).
  cors_enabled = true
  cors_extensions = [
    "css", "eot", "gif", "jpeg", "jpg", "js", "mp3", "mp4", "mpeg",
    "png", "svg", "ttf", "webm", "webp", "woff", "woff2",
  ]

  # Live values that differ from the provider's defaults. Undeclared, each would
  # be silently changed on the first apply — see the warning at the top.
  block_no_referer   = false # default true: would start rejecting refererless requests
  websockets_enabled = false # default true: nothing here serves websockets

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

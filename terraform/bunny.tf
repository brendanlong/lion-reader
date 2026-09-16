# Bunny CDN — the pull zone fronting the Fly app.
#
# The origin is the running app, not a bucket of static files, and the zone
# wraps the WHOLE site while honoring origin Cache-Control. That is what makes
# the cache settings below load-bearing rather than tuning.

resource "bunnynet_pullzone" "lionreader" {
  name = "lionreader"

  origin {
    type = "OriginUrl"
    url  = "https://lion-reader.fly.dev"
  }

  # US-only on purpose: serving from EU POPs would pull us into EU
  # data-protection obligations we don't want, and essentially all users are in
  # the US anyway. Adding a zone here is a legal decision before it is a
  # performance one.
  routing {
    tier    = "Standard"
    zones   = ["US"]
    filters = ["all"]
  }

  # -1 means "no override — obey origin Cache-Control", which is what keeps
  # HTML/RSC off the edge. A positive number CDN-caches build-coupled documents,
  # the version-skew failure in ../docs/DEPLOYMENT.md ("Why HTML and RSC are not
  # CDN-cached").
  cache_expiration_time         = -1
  cache_expiration_time_browser = -1

  # `_rsc` and `dpl` are what keep RSC payloads and post-deploy assets from
  # colliding in the edge cache (same DEPLOYMENT.md section). cache_vary is the
  # master switch and cache_vary_querystring only the parameter list it applies,
  # so dropping "querystring" would leave the list in place but unused — losing
  # exactly the collision protection it exists for.
  cache_vary             = ["querystring"]
  cache_vary_querystring = ["entry", "_rsc", "v", "dpl"]
  sort_querystring       = true

  strip_cookies = true

  # What makes cross-origin font loads work (../docs/DEPLOYMENT.md).
  cors_enabled = true
  cors_extensions = [
    "css", "eot", "gif", "jpeg", "jpg", "js", "mp3", "mp4", "mpeg",
    "png", "svg", "ttf", "webm", "webp", "woff", "woff2",
  ]

  block_no_referer   = false # true would start rejecting refererless requests
  websockets_enabled = false # nothing here serves websockets

  lifecycle {
    prevent_destroy = true
  }
}

# The custom hostname the Cloudflare `cdn` record points at. The system hostname
# (lionreader.b-cdn.net) is Bunny's and not managed here.
resource "bunnynet_pullzone_hostname" "cdn" {
  pullzone    = bunnynet_pullzone.lionreader.id
  name        = "cdn.lionreader.com"
  tls_enabled = true
  force_ssl   = false
}

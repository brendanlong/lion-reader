# Sentry — the project behind SENTRY_DSN.

resource "sentry_project" "web" {
  organization = var.sentry_organization

  # `name` is the display name, `slug` is what appears in URLs; they differ
  # here, so both are pinned.
  name     = "lion-reader"
  slug     = "lion-reader-web"
  platform = "javascript-nextjs"
  teams    = ["brendan-long"]
}

resource "sentry_key" "default" {
  organization = var.sentry_organization
  project      = sentry_project.web.slug
  name         = "Default"
}

# Not covered here: `data_scrubber` and `scrub_ip_addresses` are absent from the
# provider's schema at every level, so they are set in the Sentry UI and nothing
# here will notice if they change. Both must stay ON — "Prevent Storing of IP
# Addresses" is what stops Sentry inferring a client IP from the connection,
# which the SDK cannot do for us. The SDK-side half of that is
# `dataCollection.userInfo` in src/server/sentry.ts.

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
# here will notice if they change. The provider's own feature request for these
# settings was closed as not-planned, so that is unlikely to improve.
#
# "Prevent Storing of IP Addresses" is on at the org level and must stay on. It
# covers `user.ip_address`; it does NOT cover the IP that HTTP instrumentation
# puts on transaction spans, which src/server/sentry.ts strips instead.

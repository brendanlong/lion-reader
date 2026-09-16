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
# provider's schema at every level, so whether Sentry stores request IPs and
# strips sensitive fields stays a dashboard setting. Terraform owning the
# project does not mean it owns the project's privacy posture.

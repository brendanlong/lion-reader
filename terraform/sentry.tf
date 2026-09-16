# ---------------------------------------------------------------------------
# Sentry — the error-tracking project behind SENTRY_DSN
#
# This describes the EXISTING project, adopted by import. Nothing here creates
# infrastructure.
#
# Unlike every other resource in this module, a minimal block here is a SAFE
# adoption: `sentry_project` and `sentry_key` make almost everything
# Optional+Computed, so an attribute left out adopts the live value rather than
# asserting a default. That is why this file is short and the others are not —
# it is a property of the provider, so re-check it before assuming a newly
# added attribute behaves the same way.
#
# The exceptions are `default_rules` and `default_key`, Optional without
# Computed — but both only take effect at project *creation*, so neither can
# drive an update and neither is declared.
#
# The Required attributes are the ones to get right, `teams` above all: it is a
# Required set that is NOT RequiresReplace, so a wrong value here is a real team
# add/remove rather than a harmless default. Terraform errors on the others if
# they are missing, so they cannot go wrong silently.
# ---------------------------------------------------------------------------

resource "sentry_project" "web" {
  organization = var.sentry_organization

  # `name` is the display name and `slug` is what appears in URLs and the DSN;
  # they differ here, so both are pinned. Changing the slug invalidates nothing
  # by itself — the DSN keys off the project id — but it breaks every saved
  # link into the project.
  name     = "lion-reader"
  slug     = "lion-reader-web"
  platform = "javascript-nextjs"
  teams    = ["brendan-long"]
}

# The DSN the app reports to. There is exactly one key; Sentry created it with
# the project. Rate limits are unset, and left undeclared so they stay that way.
resource "sentry_key" "default" {
  organization = var.sentry_organization
  project      = sentry_project.web.slug
  name         = "Default"
}

# Note what this file does NOT cover: `data_scrubber` and `scrub_ip_addresses`
# are not in the provider's schema at any level, so the settings that decide
# whether Sentry stores request IPs and strips sensitive fields stay a dashboard
# concern. Terraform owning the project does not mean Terraform owns its
# privacy posture — check that in the UI.

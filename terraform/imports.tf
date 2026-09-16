# ---------------------------------------------------------------------------
# One-time adoption of the existing Mailgun objects, the domain registration,
# the Sentry project and the healthchecks.io checks.
#
# Delete this file once `terraform apply` has moved them into state — it is
# scaffolding, not configuration.
# ---------------------------------------------------------------------------

import {
  to = mailgun_domain.app
  id = "us:${var.mail_domain}"
}

import {
  to = mailgun_route.newsletter_ingest
  id = "us:69629b490a654a4aec864371"
}

import {
  to = aws_route53domains_registered_domain.lionreader
  id = var.domain
}

import {
  to = sentry_project.web
  id = "${var.sentry_organization}/lion-reader-web"
}

import {
  to = sentry_key.default
  id = "${var.sentry_organization}/lion-reader-web/602df716c7a5d9dfe207b9139d6a34d6"
}

# The import id is the check's bare uuid — the provider derives its resource id
# from the last segment of the API's update_url.
import {
  to = healthchecksio_check.this["worker"]
  id = "67ad9f99-5528-4896-b296-72fcd87403ad"
}

import {
  to = healthchecksio_check.this["feed_health"]
  id = "71238830-a7e7-4c3f-b1f1-8c6b7b64c4cb"
}

import {
  to = healthchecksio_check.this["discord_bot"]
  id = "b54191ca-fc06-4e7d-8144-66213e2e62e5"
}

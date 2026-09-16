# ---------------------------------------------------------------------------
# One-time adoption of the existing Mailgun objects and the domain registration.
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

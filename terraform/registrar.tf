# ---------------------------------------------------------------------------
# Amazon Registrar — the lionreader.com registration itself
#
# This describes the EXISTING registration, adopted by import. Nothing here
# registers or renews a domain, and `terraform destroy` does not delete it —
# it only drops the resource from state.
#
# The point of adopting it is step 4 of the migration runbook: the nameserver
# switch is the one irreversible move in this module (the `.com` parent caches
# the delegation for 48h and that TTL is not ours to lower), and until now it
# was a form in a console. Here it is a reviewable diff against a known-good
# current value.
#
# ⚠️  Unlike the contact blocks, `auto_renew`, `transfer_lock` and the four
#     privacy flags are Optional-with-default-true rather than Optional+Computed:
#     leaving one out does not adopt the live value, it asserts `true`. They are
#     declared below so the adoption plan is a no-op. If the plan proposes a
#     change to any of them, live differs from what is written here — that is a
#     decision to make deliberately, not a formality to apply past.
# ---------------------------------------------------------------------------

# Route 53 Domains is a us-east-1-only API regardless of where anything else
# lives, so this provider is pinned rather than inherited.
provider "aws" {
  region = "us-east-1"
}

resource "aws_route53domains_registered_domain" "lionreader" {
  domain_name = var.domain

  # The delegation. Still Amazon's: Cloudflare serves the zone authoritatively
  # already (cloudflare.tf), but the parent has not been pointed at it. See
  # "Cutover" in README.md for the switch and what it costs to get wrong.
  #
  # This is an ordered list and a `dig NS` answer is rotated, so the order below
  # (taken from a resolver) may not be the registrar's. Confirm it against
  # `get-domain-detail` — see README.md — or the plan shows a reorder that
  # changes nothing.
  name_server {
    name = "ns-160.awsdns-20.com"
  }
  name_server {
    name = "ns-722.awsdns-26.net"
  }
  name_server {
    name = "ns-1390.awsdns-45.org"
  }
  name_server {
    name = "ns-1717.awsdns-22.co.uk"
  }

  auto_renew    = true
  transfer_lock = true

  # WHOIS privacy. All of admin/registrant/tech must agree — the API rejects a
  # mixed set — and billing follows them here for consistency.
  admin_privacy      = true
  registrant_privacy = true
  tech_privacy       = true
  billing_privacy    = true

  # admin_contact / billing_contact / registrant_contact / tech_contact are
  # deliberately not declared. They are Optional+Computed, so omitting them
  # adopts the live values instead of overwriting them, and that keeps
  # registrant PII out of the repo. Changing WHOIS contacts is a registrar
  # console job, not a Terraform one.
}

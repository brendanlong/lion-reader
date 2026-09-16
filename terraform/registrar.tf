# Amazon Registrar — the lionreader.com registration. `terraform destroy` does
# not delete the domain; the resource's delete is a no-op that drops it from
# state.

resource "aws_route53domains_registered_domain" "lionreader" {
  domain_name = var.domain

  # Derived from the zone rather than transcribed: Cloudflare assigns the pair,
  # so the delegation cannot drift from what they serve, and a reassignment on
  # their side surfaces as a plan instead of an outage. Do not replace this with
  # a literal list read from `dig NS` — a resolver serves the pre-change answer
  # until the old record's TTL expires, so it can disagree with the parent for
  # hours. `dig +norecurse NS lionreader.com @a.gtld-servers.net` asks the parent.
  dynamic "name_server" {
    for_each = cloudflare_zone.lionreader.name_servers
    content {
      name = name_server.value
    }
  }

  auto_renew = true

  # Blocks an unauthorized transfer-out. Shows up at the registry as
  # clientTransferProhibited in the domain's status list, which is also where
  # the provider reads it back from.
  transfer_lock = true

  admin_privacy      = true
  registrant_privacy = true
  tech_privacy       = true
  billing_privacy    = true

  # The contact blocks are omitted so they keep their live values, which keeps
  # registrant PII out of the repo and out of plan output. Changing them is a
  # registrar console job.
}

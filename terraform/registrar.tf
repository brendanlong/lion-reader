# ---------------------------------------------------------------------------
# Amazon Registrar — the lionreader.com registration itself
#
# This describes the EXISTING registration, adopted by import. Nothing here
# registers or renews a domain, and `terraform destroy` does not delete it —
# the resource's delete is a no-op that only drops it from state.
#
# The point of adopting it is the delegation: pointing the `.com` parent at a
# different set of nameservers is the one irreversible operation in this module,
# since the parent caches it for 48h and that TTL is not ours to lower. That is
# a poor fit for a console form and a good fit for a reviewed diff.
#
# ⚠️  Read the live registration before the first apply, with the
#     `get-domain-detail` command in README.md. Unlike the contact blocks,
#     `auto_renew` and the four privacy flags are Optional-with-a-static-default
#     rather than Optional+Computed: leaving one out does not adopt the live
#     value, it asserts the default. Only the nameservers and `transfer_lock`
#     below have been checked against live (via the `.com` registry) — the rest
#     are the provider's defaults.
# ---------------------------------------------------------------------------

resource "aws_route53domains_registered_domain" "lionreader" {
  domain_name = var.domain

  # The delegation, taken from the zone itself rather than pasted: Cloudflare
  # assigns the pair, so this cannot drift from what they actually serve, and a
  # reassignment on their side surfaces as a plan instead of an outage.
  #
  # `dig NS` is NOT a safe source for this. A resolver keeps serving the
  # pre-change answer until the old record's TTL expires, so it can disagree
  # with the parent for hours — long enough to write down a stale set with
  # confidence. Ask the parent:
  # `dig +norecurse NS lionreader.com @a.gtld-servers.net`.
  #
  # This fixes the membership but not the order: `name_server` is an ordered
  # list the AWS provider neither sorts nor diff-suppresses, so if Cloudflare
  # lists the pair differently from the registrar the plan shows a reorder that
  # changes nothing and still issues UpdateDomainNameservers. Harmless, but it
  # breaks the no-op contract — reorder the zone's own output if it happens.
  dynamic "name_server" {
    for_each = cloudflare_zone.lionreader.name_servers
    content {
      name = name_server.value
    }
  }

  auto_renew = true

  # False is the live value, not a preference: the registry status list is
  # ["active"], with no clientTransferProhibited. Declaring it is what keeps the
  # adoption a no-op. Turning the lock on is worth doing — it is the control
  # that blocks an unauthorized transfer-out — but as its own change, where the
  # plan says so, rather than as a side effect of adopting the resource.
  transfer_lock = false

  # WHOIS privacy. The provider sends all four independently, so nothing here
  # enforces agreement between them; they are set together because a domain
  # with privacy on for one role and off for another leaks the same PII anyway.
  admin_privacy      = true
  registrant_privacy = true
  tech_privacy       = true
  billing_privacy    = true

  # admin_contact / billing_contact / registrant_contact / tech_contact are not
  # declared. They are Optional+Computed, so omitting them adopts the live
  # values instead of overwriting them, which keeps registrant PII out of the
  # repo and out of plan output.
  #
  # `tags` is neither: Optional with no default, on a transparently-tagged
  # resource, so an undeclared value plans as empty and applies UntagResource.
  # Left undeclared on the basis that the domain carries no tags — confirm with
  # `list-tags-for-domain` (README.md) before applying.
}

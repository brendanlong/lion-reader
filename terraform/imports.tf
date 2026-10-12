# Adopting the Fastmail records created in the dashboard. Delete this file once
# `terraform apply` has moved them into state — it is scaffolding, not
# configuration. The lookups find each record's Cloudflare ID so it needn't be
# pasted in; a lookup that matches nothing fails the plan rather than creating
# a duplicate.

locals {
  fastmail_lookups = {
    mx_1 = { type = "MX", name = var.domain, content = "us1-smtp.messagingengine.com" }
    mx_2 = { type = "MX", name = var.domain, content = "us2-smtp.messagingengine.com" }
    spf  = { type = "TXT", name = var.domain, content = "spf.messagingengine.com" }
    fm1  = { type = "CNAME", name = "fm1._domainkey.${var.domain}", content = "fm1.${var.domain}.dkim.fmhosted.com" }
    fm2  = { type = "CNAME", name = "fm2._domainkey.${var.domain}", content = "fm2.${var.domain}.dkim.fmhosted.com" }
    fm3  = { type = "CNAME", name = "fm3._domainkey.${var.domain}", content = "fm3.${var.domain}.dkim.fmhosted.com" }
  }
}

data "cloudflare_dns_record" "fastmail" {
  for_each = local.fastmail_lookups

  zone_id = cloudflare_zone.lionreader.id
  filter = {
    match   = "all"
    type    = each.value.type
    name    = { exact = each.value.name }
    content = { contains = each.value.content }
  }
}

import {
  to = cloudflare_dns_record.fastmail_mx_1
  id = "${cloudflare_zone.lionreader.id}/${data.cloudflare_dns_record.fastmail["mx_1"].id}"
}

import {
  to = cloudflare_dns_record.fastmail_mx_2
  id = "${cloudflare_zone.lionreader.id}/${data.cloudflare_dns_record.fastmail["mx_2"].id}"
}

import {
  to = cloudflare_dns_record.fastmail_spf
  id = "${cloudflare_zone.lionreader.id}/${data.cloudflare_dns_record.fastmail["spf"].id}"
}

import {
  for_each = toset(["fm1", "fm2", "fm3"])
  to       = cloudflare_dns_record.fastmail_dkim[each.key]
  id       = "${cloudflare_zone.lionreader.id}/${data.cloudflare_dns_record.fastmail[each.key].id}"
}

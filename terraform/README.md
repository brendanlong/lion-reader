# Infrastructure (Terraform)

Manages `lionreader.com` DNS (Cloudflare), the Bunny CDN pull zone, the Mailgun
domain and inbound route, and the domain registration at Amazon Registrar.
Modeled on the equivalent module in `brendanlong.com`, which made the same
Route53 → Cloudflare move.

Terraform owns the **entire** zone — every record, including the Mailgun SPF /
DKIM / DMARC / MX. Mailgun is part of the application, not a separate mailbox
administered on the side, so both its DNS and the Mailgun objects that DNS points
at belong with the rest of the app's infrastructure, in step with each other.

The record set was derived from the live Route53 export and verified complete
against it: all 14 non-`SOA`/`NS` records are declared, with nothing missing and
nothing invented. The one export record deliberately dropped is documented at the
top of `cloudflare.tf`.

## Credentials

```sh
export CLOUDFLARE_API_TOKEN=...   # Zone:Edit + DNS:Edit
export BUNNYNET_API_KEY=...       # NOT BUNNY_API_KEY — see providers.tf
export MAILGUN_API_KEY=...        # account key; a Sending key can't read routes
# AWS creds via the normal chain — for the S3 state backend and route53domains
```

## Adopting the registrar and Mailgun

Both are import-only and independent of the DNS cutover. Their `import` blocks
share `imports.tf`; delete that file once the apply lands, as was done for the
Bunny pull zone. The plan that adopts them must read:

```
Plan: 3 to import, 0 to add, 0 to change, 0 to destroy.
```

**Any "to change" — and above all any "must be replaced" — is a bug, not
progress.** Both have attributes whose provider default differs from live, and
an undeclared one asserts the default instead of adopting it.

### Registrar

The point of adopting it is to have the current delegation in state _before_
changing it.

The contact blocks are Optional+Computed, so they adopt silently and stay out of
the repo. `auto_renew`, `transfer_lock` and the privacy flags are not: they
default to `true`. Read the live values first and reconcile `registrar.tf` to
them rather than discovering the difference in a plan diff:

```sh
aws route53domains get-domain-detail --region us-east-1 \
  --domain-name lionreader.com \
  --query '{AutoRenew:AutoRenew,Nameservers:Nameservers[].Name,StatusList:StatusList,
            AdminPrivacy:AdminPrivacy,RegistrantPrivacy:RegistrantPrivacy,
            TechPrivacy:TechPrivacy,BillingPrivacy:BillingPrivacy}'
```

`transfer_lock` is not a field — it is derived from `StatusList` containing
`clientTransferProhibited`. Check the tag set too, since an undeclared `tags`
plans as empty and applies `UntagResource`:

```sh
aws route53domains list-tags-for-domain --region us-east-1 \
  --domain-name lionreader.com
```

### Mailgun

`mailgun_domain` has the pull zone's hazard in both directions: one attribute
that must be declared or the plan destroys the domain, and four that must not be
or the plan destroys the domain. The header of `mailgun.tf` says which and why;
read it before editing that file.

Verify after applying — a broken route is silent until someone's newsletter goes
missing:

```sh
curl -s --user "api:$MAILGUN_API_KEY" https://api.mailgun.net/v3/routes \
  | python3 -m json.tool
```

The route's `expression` must still match `INGEST_EMAIL_DOMAIN` in `../fly.toml`,
and its `forward()` target must still be a real endpoint. Then send a message to
a live ingest address and confirm the entry appears.

## Migration runbook (Route53 → Cloudflare)

**Steps 1–4 are done.** The `.com` parent has delegated to Cloudflare since
2026-09-16; `dig +norecurse NS lionreader.com @a.gtld-servers.net` is the check
that says so. Only step 5's cleanup is outstanding. The steps are kept because
the Route53 zone still exists as the rollback reference — re-running step 4
would undo the migration.

The DNS cutover was the only risky part; the Bunny adoption is import-only and
touches no traffic.

**There is no DNSSEC preflight.** `lionreader.com` is unsigned and always has
been — the parent publishes no `DS` and the zone no `DNSKEY`. This removes what
was the single most dangerous step in the brendanlong.com migration (a 24–48h
wait for the parent DS TTL). Re-verify before starting, since it is cheap:

```sh
dig +norecurse DS lionreader.com @a.gtld-servers.net +noall +answer   # must be empty
dig DNSKEY lionreader.com +short                                      # must be empty
```

### 1. Adopt Bunny (safe — no traffic impact)

Independent of DNS, so do it first.

```sh
terraform init
terraform plan
```

The plan must read exactly:

```
Plan: 3 to import, 14 to add, 0 to change, 0 to destroy.
```

**Any "to change" on the pull zone is a bug, not progress.** It means an attribute
is undeclared and the provider's default differs from the live value, so applying
would silently reconfigure the CDN. The first run of this plan surfaced three, all
of which are now declared: `cache_vary`, `block_no_referer` and
`websockets_enabled`. `prevent_destroy` turns a replace-forcing mismatch into a
hard plan error instead of a silent destroy, but it does **not** catch in-place
changes — reading the diff is the only guard there.

`bunny.tf` declares the attributes whose live values are known and whose defaults
would change behaviour if asserted — origin, routing, cache overrides, CORS, and
the query-string vary set. A pull zone has ~90 optional attributes, so rather than
hand-mapping the rest from API names, generate the authoritative config from live
state in a scratch directory (this touches nothing):

```sh
mkdir -p /tmp/bunny-gen && cd /tmp/bunny-gen
cat > main.tf <<'HCL'
terraform {
  required_providers {
    bunnynet = { source = "BunnyWay/bunnynet", version = "~> 0.15" }
  }
}
provider "bunnynet" {}
import {
  to = bunnynet_pullzone.lionreader
  id = "6171160"
}
HCL
terraform init && terraform plan -generate-config-out=generated.tf
cat generated.tf
```

Then reconcile `generated.tf` into `bunny.tf`, keeping the comments — the
generated output records _what_ the values are, and the comments record _why_.

### 2. Apply the zone + records

The Cloudflare zone already exists and is **empty**, so Terraform creates every
record rather than importing them — there is no dashboard import step and no
grey-cloud checkbox to get wrong. `proxied = false` is declared explicitly on
every proxyable record.

```sh
terraform apply
terraform output cloudflare_nameservers
```

State holds everything from here.

At this point Cloudflare is fully configured but **not yet authoritative**.
Nothing has changed for visitors.

### 3. Pre-cutover verification (before touching the registrar)

Cloudflare answers authoritatively for the zone as soon as it exists, even while
the delegation still points at Route53. So the entire post-cutover outcome can be
checked in advance, with zero risk. Anything missing here will be missing after
the cutover too — but fixing it now costs nothing.

```sh
NS=dante.ns.cloudflare.com
for q in "A lionreader.com" "AAAA lionreader.com" "CNAME cdn.lionreader.com" \
         "CNAME announcements.lionreader.com" "CNAME email.app.lionreader.com" \
         "A in.app.lionreader.com" "AAAA in.app.lionreader.com" \
         "MX in.app.lionreader.com" "TXT lionreader.com" "TXT app.lionreader.com" \
         "TXT _dmarc.app.lionreader.com" "TXT krs._domainkey.app.lionreader.com" \
         "TXT _discord.lionreader.com"; do
  printf '%-40s %s\n' "$q" "$(dig +short ${q#* } ${q%% *} @$NS | tr '\n' ' ')"
done
```

Diff that against the same loop without `@$NS` (i.e. against Route53). They must
match, with one deliberate exception: the dropped `_acme-challenge` record (see
the header of `cloudflare.tf`).

This is also what catches **TXT quoting drift** — Cloudflare and Route53 differ
on whether TXT values carry surrounding quotes, and SPF/DKIM/DMARC breakage is
otherwise silent. Compare the answers, not the config.

`cdn.lionreader.com` must answer with a **CNAME**, not an A. An A record there
means it got proxied or flattened.

### 4. Cutover

Done in the Amazon Registrar console, before `registrar.tf` existed. The
delegation now lives in Terraform, derived from
`cloudflare_zone.lionreader.name_servers`, so a future change to it is a plan
to read rather than a form to fill in.

Wait for `terraform output cloudflare_zone_status` to read `active`.

**There is no fast rollback.** The delegation TTL is set at the `.com` parent at
172800s (48h) and is not ours to lower, so reverting the registrar leaves traffic
split across both providers for up to two days. Lowering record TTLs beforehand
does not affect this — it is a different TTL. The real recovery lever is fixing
forward in Cloudflare. Don't cut over immediately before time away.

### 5. Verify and clean up

- `flyctl certs list -a lion-reader` — `lionreader.com` still `Issued`, and still
  renewing (recheck in ~30 days). It is the only certificate.
- Send a newsletter to an ingest address; confirm it lands. Mail breakage is
  silent — nothing alerts on an `MX` that stops resolving.
- Load the app; confirm assets come from `cdn.lionreader.com`.
- `https://announcements.lionreader.com/feed.xml` returns 200.
- After a full certificate renewal cycle, delete the Route53 hosted zone
  (`/hostedzone/Z10027742EOOBZLO22ICY`). Leave it intact until then — it is the
  rollback reference.

## Day-to-day

```sh
terraform plan
terraform apply
```

Runs from any machine — state and locking live in S3. This module does **not**
run in CI; infra changes are rare and we don't want CI holding cloud-admin
credentials. Keep applies manual and local.

## Note: the CDN is US-only on purpose

Only the `US` geo zone is enabled. Serving from EU POPs would pull us into EU
data-protection obligations we don't want to take on, and essentially all users
are in the US anyway. Adding a zone in `bunny.tf` is a legal decision before it is
a performance one — don't enable one to shave latency without that conversation.

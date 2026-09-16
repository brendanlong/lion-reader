# Infrastructure (Terraform)

Manages `lionreader.com` DNS (Cloudflare) and the Bunny CDN pull zone. Modeled
on the equivalent module in `brendanlong.com`, which made the same Route53 →
Cloudflare move.

Scope is deliberately partial. Terraform owns:

- the Cloudflare zone
- every **A / AAAA / CNAME** record — the proxyable types, where `proxied = false`
  is an invariant worth enforcing in code (see `../docs/DEPLOYMENT.md`)
- the Bunny pull zone and its `cdn.lionreader.com` hostname

Terraform does **not** own the **TXT / MX** records (SPF, DKIM, DMARC, Discord
and Google verification, Mailgun MX). Cloudflare cannot proxy those, so there is
no grey-cloud decision to get wrong, and they change on Mailgun's schedule rather
than ours. They are imported once from `cloudflare-import.zone` and managed in
the dashboard. The provider only touches records it declares, so this is safe and
shows no drift.

## Credentials

```sh
export CLOUDFLARE_API_TOKEN=...   # Zone:Edit + DNS:Edit
export BUNNYNET_API_KEY=...       # NOT BUNNY_API_KEY — see providers.tf
# AWS creds for the S3 state backend via the normal AWS chain
```

## Migration runbook (Route53 → Cloudflare)

The DNS cutover is the only risky part; the Bunny adoption is import-only and
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

The plan **must** show the imports and **no changes**. If it proposes any
attribute change, a value in `bunny.tf` does not match the live zone — reconcile
it rather than applying. `prevent_destroy` turns a replace-forcing mismatch into
a hard plan error instead of a silent destroy.

### 2. Import the TXT/MX records

In the Cloudflare dashboard, DNS → Records → Import, upload
`cloudflare-import.zone`. It was generated from the live Route53 export and
round-trip verified against it.

Then **confirm every imported record is DNS-only (grey cloud)**. Cloudflare's
importer can default records to proxied; the BIND import screen has a "Proxy
imported DNS records" checkbox that avoids the toggling if you uncheck it.

### 3. Apply the zone + records

```sh
terraform apply
terraform output cloudflare_nameservers
```

Then delete `imports.tf` and commit — state holds everything from here.

At this point Cloudflare is fully configured but **not yet authoritative**.
Nothing has changed for visitors.

### 4. Pre-cutover verification (before touching the registrar)

Cloudflare answers authoritatively for the zone as soon as it exists, even while
the delegation still points at Route53. So the entire post-cutover outcome can be
checked in advance, with zero risk. Anything missing here will be missing after
the cutover too — but fixing it now costs nothing.

```sh
NS=<one of the nameservers from step 3>
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
`cloudflare-import.zone` header).

`cdn.lionreader.com` must answer with a **CNAME**, not an A. An A record there
means it got proxied or flattened.

### 5. Cutover

Replace the four `awsdns` nameservers at the registrar with Cloudflare's two.
Then wait for `terraform output cloudflare_zone_status` to read `active`.

**There is no fast rollback.** The delegation TTL is set at the `.com` parent at
172800s (48h) and is not ours to lower, so reverting the registrar leaves traffic
split across both providers for up to two days. Lowering record TTLs beforehand
does not affect this — it is a different TTL. The real recovery lever is fixing
forward in Cloudflare. Don't cut over immediately before time away.

### 6. Verify and clean up

- `flyctl certs list -a lion-reader` — `lionreader.com` still `Issued`, and still
  renewing (recheck in ~30 days). It is the only certificate.
- Send a newsletter to an ingest address; confirm it lands and a tracked link
  resolves. DKIM/SPF/tracking breakage is silent.
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

## Note: the CDN is US-only

The live pull zone has only the `US` geo zone enabled (`EnableGeoZoneEU`, `ASIA`,
`SA`, `AF` are all false), so non-US visitors are served from US POPs. That is
captured as-is in `bunny.tf` rather than "fixed", since enabling zones is a
coverage and billing change. Worth revisiting deliberately — it caps what Bunny's
GeoDNS steering can actually do.

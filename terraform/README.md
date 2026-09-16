# Infrastructure (Terraform)

Manages `lionreader.com` DNS (Cloudflare), the Bunny CDN pull zone, the Mailgun
domain and inbound route, the domain registration at Amazon Registrar, and the
Sentry project. Modeled on the equivalent module in `brendanlong.com`, which
made the same Route53 → Cloudflare move.

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
export SENTRY_AUTH_TOKEN=...      # org:read + project:write
# AWS creds via the normal chain — for the S3 state backend and route53domains
```

## Adopting the registrar, Mailgun and Sentry

All three are import-only and touch no traffic. Their `import` blocks share
`imports.tf`; delete that file once the apply lands. The plan that adopts them
must read:

```
Plan: 5 to import, 0 to add, 0 to change, 0 to destroy.
```

**Any "must be replaced" is a bug, not progress**, and so is any "to change"
except on the registrar — its unreadable flags are reconciled below rather than
pre-verified, so a diff there is information, not a defect. Whether either is
even possible depends on the provider, and the
difference is worth knowing before writing a resource: an attribute that is
Optional+Computed adopts its live value when omitted, while one that is Optional
with a static default _asserts_ that default and changes live on apply. Sentry
is almost entirely the former, Mailgun and the registrar are not.

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

### Sentry

Nothing to reconcile — see the header of `sentry.tf` for why the short block is
safe here. The DSN comes back as an output, which is what makes a key rotation
reproducible for the **server**:

```sh
flyctl secrets set -a lion-reader SENTRY_DSN="$(terraform output -raw sentry_dsn)"
```

The client half is not a secret and cannot be set as one:
`NEXT_PUBLIC_SENTRY_DSN` is inlined into the browser bundle at build time, so it
has to go in `[build.args]` in `../fly.toml` and ship on the next deploy. A Fly
secret by that name has no effect at all.

Importing `sentry_key` also puts the key's _secret_ DSN in the state file, since
the provider returns `dsn` as one map. That is why the output is marked
sensitive even though the public DSN is not — the marking is forced, not a
judgement about the public value.

## Route53 → Cloudflare: what is left

The `.com` parent has delegated to Cloudflare since 2026-09-16 — ask the parent,
not a resolver, since a resolver serves the old answer until its TTL expires:

```sh
dig +norecurse NS lionreader.com @a.gtld-servers.net +noall +authority
```

Outstanding:

- After a full certificate renewal cycle, delete the Route53 hosted zone
  (`/hostedzone/Z10027742EOOBZLO22ICY`). Until then it is the rollback
  reference, and it is why nothing may repoint the delegation at Route53 by
  accident — see the `name_server` comment in `registrar.tf`.
- `flyctl certs list -a lion-reader` — `lionreader.com` still `Issued` and still
  renewing (recheck ~30 days after the cutover). It is the only certificate.

**There is no fast rollback from a delegation change.** The TTL at the `.com`
parent is 172800s (48h) and is not ours to lower, so repointing the registrar
splits traffic across both providers for up to two days. Record TTLs do not
affect this — it is a different TTL. The recovery lever is fixing forward in
Cloudflare.

## Verifying the zone

Cloudflare answers authoritatively for the zone whoever the parent delegates to,
so this works as a pre-change check as well as an after-the-fact one. It is also
what catches **TXT quoting drift**: providers differ on whether TXT values carry
surrounding quotes, and SPF/DKIM/DMARC breakage is otherwise silent. Compare the
answers, not the config.

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

`cdn.lionreader.com` must answer with a **CNAME**, not an A. An A record there
means it got proxied or flattened.

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

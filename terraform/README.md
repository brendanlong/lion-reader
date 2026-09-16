# Infrastructure (Terraform)

Everything about the deployment is managed either by Fly.io (`../fly.toml`) or
here. This module owns `lionreader.com` DNS (Cloudflare), the Bunny CDN pull
zone, Mailgun, Sentry, the healthchecks.io monitors, and the domain registration
at Amazon Registrar. Change them here, not in a dashboard.

Modeled on the equivalent module in `brendanlong.com`, which made the same
Route53 → Cloudflare move.

## Credentials

```sh
export CLOUDFLARE_API_TOKEN=...   # Zone:Edit + DNS:Edit
export BUNNYNET_API_KEY=...       # see providers.tf on the name
export MAILGUN_API_KEY=...        # account key; a Sending key can't read routes
export SENTRY_AUTH_TOKEN=...      # org:read + project:write
export HEALTHCHECKSIO_API_KEY=... # must be read-write; see providers.tf
# AWS creds via the normal chain — for the S3 state backend and route53domains
```

## Always read the plan

```sh
terraform plan
terraform apply
```

`plan` is the only safety mechanism here, and it is sufficient — but only if the
diff is read rather than skimmed. **A `~` or `must be replaced` on a resource you
did not mean to touch is a bug, not progress.** Two things make that worth the
attention:

- Providers differ on what an _omitted_ attribute means. Some adopt whatever is
  live; others assert a static default and change it. So adding a resource, or
  adding an attribute to one, can move something you never named.
- Several of these services fail silently when misconfigured. A detached
  notification channel, a mail route that stops matching, or a CDN that starts
  caching HTML all look fine from outside until much later.

`prevent_destroy` guards the few resources where a replace would be destructive.
It does not catch in-place changes, so it is not a substitute for reading.

Runs from any machine — state and locking live in S3. This module does **not**
run in CI; infra changes are rare and we don't want CI holding cloud-admin
credentials. Keep applies manual and local.

## Wiring outputs into Fly secrets

```sh
flyctl secrets set -a lion-reader SENTRY_DSN="$(terraform output -raw sentry_dsn)"

terraform output -json healthcheck_ping_urls \
  | python3 -c 'import json,sys;[print(f"{k}={v}") for k,v in json.load(sys.stdin).items()]' \
  | flyctl secrets import -a lion-reader
```

`NEXT_PUBLIC_SENTRY_DSN` is the exception and cannot be a secret: it is inlined
into the browser bundle at build time, so it belongs in `[build.args]` in
`../fly.toml` and ships on the next deploy.

## Route53 → Cloudflare: what is left

The `.com` parent has delegated to Cloudflare since 2026-09-16. Ask the parent,
not a resolver, since a resolver serves the old answer until its TTL expires:

```sh
dig +norecurse NS lionreader.com @a.gtld-servers.net +noall +authority
```

Outstanding:

- After a full certificate renewal cycle, delete the Route53 hosted zone
  (`/hostedzone/Z10027742EOOBZLO22ICY`). Until then it is the rollback reference.
- `flyctl certs list -a lion-reader` — `lionreader.com` still `Issued` and still
  renewing. It is the only certificate.

**There is no fast rollback from a delegation change.** The TTL at the `.com`
parent is 172800s (48h) and is not ours to lower, so repointing the registrar
splits traffic across both providers for up to two days. Record TTLs do not
affect this — it is a different TTL. The recovery lever is fixing forward in
Cloudflare.

## Verifying the zone

Cloudflare answers authoritatively whoever the parent delegates to, so this works
as a pre-change check as well as an after-the-fact one. It is also what catches
**TXT quoting drift**: providers differ on whether TXT values carry surrounding
quotes, and SPF/DKIM/DMARC breakage is otherwise silent. Compare the answers, not
the config.

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

After a Mailgun change, confirm the route still matches `INGEST_EMAIL_DOMAIN` in
`../fly.toml` and send a message to a live ingest address — a broken route is
silent until someone's newsletter goes missing.

## Note: the CDN is US-only on purpose

Only the `US` geo zone is enabled. Serving from EU POPs would pull us into EU
data-protection obligations we don't want to take on, and essentially all users
are in the US anyway. Adding a zone in `bunny.tf` is a legal decision before it is
a performance one — don't enable one to shave latency without that conversation.

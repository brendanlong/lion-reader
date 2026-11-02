#!/bin/sh
# Runs the given command, first joining our tailnet when
# TAILSCALE_OAUTH_CLIENT_SECRET is set (docs/DEPLOYMENT.md, "Self-hosted voices
# over Tailscale").
#
# Userspace networking, so it needs no root and the VM's network is untouched:
# the tailnet is reachable only through tailscaled's proxy at
# SELFHOSTED_PROXY_URL, which only the self-hosted speech client uses.
# `tailscale up` runs in the background so the app starts even when Tailscale
# can't be reached; speech fails over to other hosts meanwhile.
set -eu

if [ -n "${TAILSCALE_OAUTH_CLIENT_SECRET:-}" ]; then
  socket=/tmp/tailscaled.sock
  tailscaled --tun=userspace-networking --state=mem: --socket="$socket" \
    --outbound-http-proxy-listen="${SELFHOSTED_PROXY_URL#http://}" --no-logs-no-support &
  (
    until [ -S "$socket" ]; do sleep 0.1; done
    tailscale --socket="$socket" up \
      --auth-key="${TAILSCALE_OAUTH_CLIENT_SECRET}?ephemeral=true&preauthorized=true" \
      --advertise-tags=tag:lion-reader --hostname="lion-reader-${FLY_MACHINE_ID:-local}" \
      --shields-up
  ) &
fi

exec "$@"

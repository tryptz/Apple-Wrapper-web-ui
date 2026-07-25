#!/bin/sh
# Bring up Tailscale (userspace — Railway containers have no /dev/net/tun),
# then start the web UI. Tailscale is optional: without TAILSCALE_AUTHKEY the
# UI still boots and simply can't reach tailnet-only hosts.
set -e

if [ -n "${TAILSCALE_AUTHKEY}" ]; then
  echo "[tailscale] starting userspace daemon…"
  /usr/sbin/tailscaled \
    --tun=userspace-networking \
    --socks5-server=localhost:1055 \
    --outbound-http-proxy-listen=localhost:1055 \
    --statedir=/tmp/tailscale &

  # Wait for the socket rather than sleeping a fixed amount.
  i=0
  while [ ! -S /var/run/tailscale/tailscaled.sock ] && [ $i -lt 30 ]; do
    i=$((i+1)); sleep 1
  done

  /usr/bin/tailscale up \
    --authkey="${TAILSCALE_AUTHKEY}" \
    --hostname="${TAILSCALE_HOSTNAME:-apple-webui}" \
    --accept-routes \
    ${TAILSCALE_UP_ARGS} || echo "[tailscale] up failed — continuing without tailnet"

  echo "[tailscale] $(/usr/bin/tailscale ip -4 2>/dev/null || echo 'no address')"

  # Route Node's outbound traffic through the tailnet proxy so plain
  # fetch()/http.request to a 100.x address or MagicDNS name just works.
  export ALL_PROXY="socks5://localhost:1055/"
  export HTTP_PROXY="http://localhost:1055/"
  export HTTPS_PROXY="http://localhost:1055/"
  export NO_PROXY="localhost,127.0.0.1,.railway.internal"
else
  echo "[tailscale] TAILSCALE_AUTHKEY not set — skipping tailnet"
fi

exec node /app/webui/server.js

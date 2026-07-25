#!/bin/sh
# Bring up Tailscale (userspace — Railway containers have no /dev/net/tun),
# then start the web UI. Tailscale is optional: without TAILSCALE_AUTHKEY the
# UI still boots and simply can't reach tailnet-only hosts.
set -e

if [ -n "${TAILSCALE_AUTHKEY}" ]; then
  echo "[tailscale] starting userspace daemon…"
  # Distinct ports: pointing SOCKS and the HTTP proxy at 1055 made them collide.
  /usr/sbin/tailscaled \
    --tun=userspace-networking \
    --socks5-server=localhost:1054 \
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

  # IMPORTANT: Node does NOT honour HTTP_PROXY / ALL_PROXY. Unlike curl, its
  # http.request has no implicit proxy support, so exporting these alone left
  # every tailnet request failing with EHOSTUNREACH — userspace mode has no
  # network interface to route through, so traffic MUST go via the proxy.
  # server.js reads TS_HTTP_PROXY and proxies explicitly. The conventional
  # vars stay exported for child processes that do respect them.
  export TS_HTTP_PROXY="http://127.0.0.1:1055"
  export ALL_PROXY="socks5://127.0.0.1:1054"
  export HTTP_PROXY="http://127.0.0.1:1055"
  export HTTPS_PROXY="http://127.0.0.1:1055"
  export NO_PROXY="localhost,127.0.0.1,.railway.internal"
else
  echo "[tailscale] TAILSCALE_AUTHKEY not set — skipping tailnet"
fi

exec node /app/webui/server.js

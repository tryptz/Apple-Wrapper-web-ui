# Web UI service (Railway).
#
# Two differences from running the UI on your own machine:
#   1. There is no Docker daemon here, so the UI cannot start/stop the wrapper
#      container. It talks to the wrapper over HTTP instead — see WRAPPER_URL.
#   2. Tailscale runs inside the container in userspace mode, so this service
#      can reach hosts on your tailnet (and be reached from it) without any
#      public exposure.

FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl iptables \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg \
      -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list \
      -o /etc/apt/sources.list.d/tailscale.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends tailscale \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY webui/ ./webui/
COPY docker/webui-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Railway injects PORT; the server already honours it.
ENV PORT=8080
EXPOSE 8080

CMD ["/app/entrypoint.sh"]

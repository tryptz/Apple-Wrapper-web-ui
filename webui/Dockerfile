# Web UI service (Railway).
#
# CONTEXT: the repo ROOT, not webui/. `railway up` uploads the git repo root
# no matter which directory it is invoked from, so paths here are repo-relative
# and the service selects this file via RAILWAY_DOCKERFILE_PATH=webui/Dockerfile.
#
# Two differences from running the UI on your own machine:
#   1. There is no Docker daemon here, so the UI cannot start/stop containers.
#      It proxies to a LOCAL-mode agent instead — see AGENT_URL.
#   2. Tailscale runs in userspace mode, so this service can reach hosts on
#      your tailnet without any public exposure.

FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg \
      -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.tailscale-keyring.list \
      -o /etc/apt/sources.list.d/tailscale.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends tailscale \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY webui/ /app/webui/
RUN chmod +x /app/webui/entrypoint.sh

ENV PORT=8080
EXPOSE 8080

CMD ["/app/webui/entrypoint.sh"]

#!/bin/sh
set -e

TOKEN_DB_PATH="/app/rootfs/data/data/com.apple.android.music/files/mpl_db/kvs.sqlitedb"

if [ ! -d "/app/rootfs/data/data/com.apple.android.music/files" ]; then
  mkdir -p "/app/rootfs/data/data/com.apple.android.music/files"
fi

if [ $(stat -c %U "/app/rootfs/data") != "root" ] || [ $(stat -c %G "/app/rootfs/data") != "root" ]; then
  chown -R root:root "/app/rootfs/data"
fi

# Guard against a second wrapper instance. Both this container and the web-UI
# "am-wrapper" container run with --network host and bind ports 10020/20020/30020,
# and both write the same login DBs under rootfs/data. Two live instances race on
# those SQLite files and corrupt each other's token ("SSL token is invalid or
# expired"). Refuse to start if the main control port is already listening.
# Set ALLOW_MULTIPLE=1 to bypass (not recommended).
if [ -z "${ALLOW_MULTIPLE}" ]; then
  PORT_HEX=$(printf '%04X' 10020)  # 2724
  if grep -qiE ":${PORT_HEX}[[:space:]]+[0-9A-Fa-f]+:0000[[:space:]]+0A" \
       /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
    echo "Error: another wrapper is already listening on port 10020." >&2
    echo "Refusing to start a second instance (it would corrupt the shared login DB)." >&2
    echo "Stop the other container first, or set ALLOW_MULTIPLE=1 to override." >&2
    exit 1
  fi
fi

if [ ! -f "$TOKEN_DB_PATH" ]; then
  echo "Login required: account database not found."
  if [ -z "${USERNAME}" ] || [ -z "${PASSWORD}" ]; then
    echo "Error: USERNAME and PASSWORD environment variables must be set when account database is missing." >&2
    exit 1
  fi
  exec ./wrapper \
    -L "${USERNAME}:${PASSWORD}" \
    -F \
    -H 0.0.0.0 \
    "$@"
else
  exec ./wrapper \
    -H 0.0.0.0 \
    "$@"
fi

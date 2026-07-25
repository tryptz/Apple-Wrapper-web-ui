# Apple Wrapper Web UI

A small web front-end plus Docker packaging for the Apple Music Android
wrapper. The container runs the wrapper binary against an Android `rootfs`
and exposes a browser UI for driving it.

## What's in this repo

| Path | Purpose |
|---|---|
| `webui/server.js` | Node server backing the browser UI |
| `webui/public/index.html` | The UI itself |
| `Dockerfile` | Two-stage build; uses a prebuilt `wrapper` binary when present, otherwise builds from source via the Android NDK |
| `compose.yaml` | Service definition and port mapping |
| `entrypoint.sh` | Container entrypoint |
| `wrapper` | Prebuilt `linux/amd64` wrapper binary (skips the NDK build) |
| `Start Apple Music UI.bat` | Windows launcher |

Ports exposed: `10020`, `20020`, `30020`.

## What's deliberately NOT in this repo

Three things are gitignored and must be supplied locally — the repo will
not run without them:

### `rootfs/data/` — your Apple Music session
Contains `MUSIC_TOKEN`, `IC-Info.sids`, `fsi.pdat` and the
`mpl_db/*.sqlitedb` cookie/account databases. **These are credentials for a
signed-in Apple Music account.** They are per-user, must never be
committed, and should never be shared.

### `rootfs/system/` — Android runtime libraries
~118 MB of `.so` libraries and `linker64`/`main` extracted from an Android
system image and the Apple Music APK. Proprietary Apple/Google binaries, so
they are not redistributed here.

### `downloads/` — ripped audio
Output directory. Multi-gigabyte and copyrighted.

## Getting started (new users)

You do **not** need to hand-place a token or edit any config. Start the web UI
and it walks you through setup:

```bash
node webui/server.js
```

Then open <http://localhost:8080>. On Windows, `Start Apple Music UI.bat` does
the same thing.

On first run a **setup wizard** opens automatically and checks four things
live, re-testing whenever you hit *Re-check*:

| Check | What it wants |
|---|---|
| Docker running | Docker Desktop installed and started |
| Docker Compose | the `docker compose` plugin (ships with Desktop) |
| Android runtime | `rootfs/system/` containing `bin/linker64` and `lib64/libandroidappmusic.so` |
| Apple Music session | a signed-in session in `rootfs/data/` |

Anything red shows what to do about it. Once the first three pass, a sign-in
form appears: enter your Apple ID and the wizard starts the container, logs in,
and waits for the session token to appear. When all four are green you're in.

### About your password

It is sent to the container for that single sign-in and **never written to
disk** by the web UI, never stored in the browser, and never committed. Only
the resulting session token is persisted, under `rootfs/data/`. The password
field is cleared as soon as login is submitted.

If your Apple ID has two-factor authentication, generate an
[app-specific password](https://account.apple.com) and use that.

After the first login no credentials are needed at all — the wrapper reuses the
saved session, and the main screen's **Start wrapper** button takes no password.

### Switching accounts / fixing a bad token

Open **Setup → Sign out**. That stops the container and deletes the saved
session so you can sign in as someone else. An expired or corrupted token
("SSL token is invalid or expired") is fixed the same way. Downloaded files are
never touched.

## Running manually

If you'd rather skip the UI, supply credentials via a local `.env` file next to
`compose.yaml` (gitignored) and run compose directly:

```bash
docker compose up --build
```

## Note

This tooling automates a client for a paid streaming service. Keep it
private, keep your session files out of version control, and be aware of
Apple Music's terms of service before sharing or distributing anything it
produces.

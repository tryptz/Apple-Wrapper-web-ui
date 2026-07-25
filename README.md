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

## Running

Provide `rootfs/system/` and `rootfs/data/`, then:

```bash
docker compose up --build
```

On Windows, `Start Apple Music UI.bat` wraps the same thing.

## Note

This tooling automates a client for a paid streaming service. Keep it
private, keep your session files out of version control, and be aware of
Apple Music's terms of service before sharing or distributing anything it
produces.

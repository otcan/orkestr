# Framework And Deployment

Orkestr is split into two deployable layers:

- NestJS API in `apps/server`.
- Angular web app in `apps/web/src`, built into `dist/web/browser`.

The NestJS process serves both `/api/*` routes and the compiled Angular app.
The server does not compile Angular at runtime. A local or container deployment
must run `npm run build` before `npm start`.

## Local Development

```bash
npm install
npm run dev
```

`npm run dev` builds the Angular app once and starts the NestJS server with the
browser-open flag. Re-run `npm run build` after frontend changes before
refreshing the server-served UI.

## Verification

```bash
npm run check
npm run smoke
npm run demo:coding-agent
```

`npm run check` performs JavaScript syntax checks, compiles the NestJS backend,
builds Angular, and runs the Node test suite.

## Deployment Paths

Use Docker for first-run demos and host-native systemd for a VPS.

Docker is intentionally the easiest local path: the image bundles Codex, tmux,
git, ripgrep, Chromium, and the compiled Orkestr app. It is also useful for
quick demos and throwaway test environments.

The VPS path should be host-native. Caddy, Tailscale, browser desktops,
systemd logs, SSH pairing approval, and long-running agent work are host-level
operations. Running the server directly under systemd keeps those operations
plain:

```bash
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/install.sh | sudo bash -s -- --systemd
```

The installer creates:

```text
/opt/orkestr/app        cloned Orkestr source and built app
/opt/orkestr/data       ORKESTR_HOME
/opt/orkestr/workspace  default agent workspace root
/etc/orkestr/orkestr.env
/usr/local/bin/orkestr
/etc/systemd/system/orkestr.service
```

The service uses `ORKESTR_HOST=127.0.0.1` by default. For remote access, put a
host-managed reverse proxy such as Caddy in front, preferably reachable through
Tailscale HTTPS or a domain you control. Set the public URL and secure cookie
settings in `/etc/orkestr/orkestr.env`, then restart:

```bash
sudoedit /etc/orkestr/orkestr.env
sudo systemctl restart orkestr
```

Useful VPS commands:

```bash
systemctl status orkestr
journalctl -u orkestr -f
orkestr security approve <challenge-id>
orkestr security challenges
```

The generated `/usr/local/bin/orkestr` wrapper can be run from a root SSH
session. It switches to `ORKESTR_RUN_USER` before reading or writing local
Orkestr state, which keeps `ORKESTR_HOME` owned by the same user that runs
`orkestr.service`.

## On-Box Update Watcher

For a personal VPS, prefer a small host-local updater over an external deploy
pipeline:

```bash
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/install.sh | sudo bash -s -- --systemd --auto-update
```

`--auto-update` installs:

```text
/usr/local/bin/orkestr-update
/etc/systemd/system/orkestr-update.service
/etc/systemd/system/orkestr-update.timer
```

The timer runs every two minutes by default. Each run fetches the configured
repo, resolves `ORKESTR_UPDATE_REF` (default: `main`), exits if the checkout is
already current, and otherwise runs:

```bash
npm ci
npm run build
npm prune --omit=dev
systemctl restart orkestr.service
```

For disposable VPS environments, add this to `/etc/orkestr/orkestr.env`:

```bash
ORKESTR_RESET_ON_UPDATE=1
ORKESTR_RESET_OVERLAY=1
```

With reset enabled, the updater stops `orkestr.service` after a successful
build, runs `orkestr-reset-state`, and then restarts the service. The reset
preserves `/etc/orkestr/orkestr.env`, `/opt/orkestr/app`, systemd units,
Caddy/Tailscale state, and OS packages. It wipes `ORKESTR_HOME`, the runtime
workspace root, Codex home when it lives under `ORKESTR_HOME`, and the overlay
only when `ORKESTR_RESET_OVERLAY=1`.

The updater refuses to run when `/opt/orkestr/app` has local tracked changes.
It keeps the existing `/etc/orkestr/orkestr.env`, so OpenAI keys, OAuth
credentials, Caddy/Tailscale URLs, and private overlay paths remain
server-local.

Useful updater commands:

```bash
systemctl list-timers orkestr-update.timer
journalctl -u orkestr-update -f
orkestr-update
orkestr-reset-state
```

## Local Docker

```bash
cp .env.docker.example .env
docker compose up -d
```

The default Compose file runs the published image:

```text
ghcr.io/otcan/orkestr:latest
```

For a local source build, layer the build override:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

The Dockerfile uses a multi-stage build:

- `build` installs all dependencies, compiles the NestJS backend, and compiles Angular.
- `runtime` installs production dependencies plus Codex, tmux, git, ripgrep,
  Chromium, and process tools, copies server code and `dist`, and runs the
  compiled NestJS server with `npm start`.

Runtime data is stored in `ORKESTR_HOME`, which defaults to `/data` in the
container. `CODEX_HOME` defaults to `/data/codex`, so Codex device auth or
API-key login started from the setup UI persists in the same Docker volume.
Orkestr checks the real Codex CLI login status before waking a coding runtime;
an unconfigured runtime sends the user back to `/setup/codex` instead of
opening the raw Codex login menu in tmux. Docker settings are read from `.env`
by Compose; start from `.env.docker.example` for optional OpenAI direct API
access, Tailscale/Caddy, OAuth, workspace, and overlay settings. If a setup UI
accepts an uploaded or pasted `.env`, treat it as runtime configuration: read
it explicitly, store it with server-local state, and never commit it. Private
overlays are mounted separately with `ORKESTR_OVERLAY_DIR`; do not bake
secrets, WhatsApp state, browser profiles, or personal prompts into the public
image.

## Tailscale Demo Route

For demos that must not touch a public hostname, run Orkestr on a local port and
publish only through Tailscale Serve:

```bash
ORKESTR_HOST=127.0.0.1 ORKESTR_PORT=19813 npm start
tailscale serve --bg 443 http://127.0.0.1:19813
```

If another reverse proxy already owns port 443 on the tailnet IP, use a
dedicated demo port instead:

```bash
tailscale serve --bg --https 8443 http://127.0.0.1:19813
```

Use a clean `ORKESTR_HOME` and workspace root for that demo runtime. Do not
point the route at a personal overlay, personal shadow service, or production
Orkestr home.

## Release Checklist

1. Confirm `git status --short` is clean.
2. Run `npm run check`.
3. Run `npm run smoke`.
4. Run `npm run demo:coding-agent`.
5. Run `npm run docker:build`.
6. Review `README.md`, `docs/private-overlay.md`, and this file.
7. Tag and publish only after the private overlay has been checked for leaks.

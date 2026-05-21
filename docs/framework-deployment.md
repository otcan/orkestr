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

To verify the full fresh-VPS installer path on disposable AWS infrastructure,
run:

```bash
npm run smoke:vps:aws
```

This creates a new Ubuntu 24.04 EC2 instance, allows SSH only from the current
machine, runs the host-native bootstrap installer, runs `npm run smoke` on the
new VPS, and then deletes the instance, temporary key pair, and security group.
It defaults to `t3.medium`, 60 GB root disk, no Tailscale, and no auto-update so
the check stays isolated and disposable.

To also verify that the built-in WhatsApp bridge can be started and reaches QR
readiness on the fresh VPS, add:

```bash
npm run smoke:vps:aws -- --with-whatsapp
```

## Deployment Paths

Use Docker for first-run demos and host-native systemd for a VPS.

Docker is intentionally the easiest local path: the image bundles Codex, tmux,
git, ripgrep, Chromium, and the compiled Orkestr app. It is also useful for
quick demos and throwaway test environments.

The VPS path should be host-native. Caddy, Tailscale, browser desktops,
systemd logs, SSH pairing approval, and long-running agent work are host-level
operations. Running the server directly under systemd keeps those operations
plain.

### Fresh VPS Bootstrap

Choose **Ubuntu 24.04 LTS Server x64** for the easiest install path. Ubuntu
26.04 LTS is accepted by the bootstrap script, but 24.04 remains the default
recommendation because it is the most common stable image across DigitalOcean,
Hetzner, and similar VPS providers.

Minimum practical size:

```text
2 vCPU
4 GB RAM
60 GB disk
```

Preferred size for browser-heavy work:

```text
4 vCPU
8 GB RAM
80-120 GB disk
```

The one-command fresh-server path is:

```bash
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/bootstrap-vps.sh | sudo bash
```

By default, `bootstrap-vps.sh`:

- checks OS, CPU architecture, memory, and disk
- installs Tailscale, but does not force login unless `TS_AUTHKEY` or
  `--tailscale-up` is provided
- runs `scripts/install.sh --systemd --auto-update`
- keeps Orkestr bound to `127.0.0.1`
- configures Tailscale Serve automatically when Tailscale is already connected
- optionally configures Caddy when `--domain` is supplied
- runs `orkestr doctor`
- prints local, Tailscale, and domain access instructions

Common variants:

```bash
# Disposable demo host. Runtime state resets after successful updates.
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/bootstrap-vps.sh | sudo bash -s -- --demo

# Public HTTPS domain through Caddy.
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/bootstrap-vps.sh | sudo bash -s -- --domain orkestr.example.com

# Tailscale unattended setup. Prefer a secret manager; this interactive form avoids shell history.
read -rsp "Tailscale auth key: " TS_AUTHKEY; echo
export TS_AUTHKEY
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/bootstrap-vps.sh | sudo -E bash
unset TS_AUTHKEY

# Custom fork, branch, tag, or commit.
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/bootstrap-vps.sh | sudo bash -s -- --repo https://github.com/you/orkestr.git --ref main
```

### Disposable AWS Installer Smoke

When changing the installer or onboarding docs, test the real fresh-server path
instead of reusing an existing Orkestr box:

```bash
npm run smoke:vps:aws
```

The script requires `aws`, `ssh`, `scp`, `curl`, and `ssh-keygen` on the
control machine, plus AWS credentials that can create and delete EC2 instances,
security groups, and key pairs. It does not expose Orkestr publicly; the
temporary security group only opens SSH from the controller's public IP.

Useful variants:

```bash
# Test a branch or fork.
npm run smoke:vps:aws -- --repo https://github.com/you/orkestr.git --ref my-branch

# Test local bootstrap/install script edits while still installing a pushed ref.
npm run smoke:vps:aws -- --local-bootstrap --ref my-branch

# Keep the VPS after a failure for SSH debugging.
npm run smoke:vps:aws -- --keep-on-failure

# Start the built-in WhatsApp bridge and wait for QR readiness.
npm run smoke:vps:aws -- --with-whatsapp

# Start phone-number pairing, print the temporary code, wait for approval,
# and create a self-chat-backed test thread after pairing succeeds.
npm run smoke:vps:aws -- \
  --with-whatsapp \
  --whatsapp-phone +491234567890 \
  --whatsapp-pair-timeout 600 \
  --create-whatsapp-thread "WhatsApp VPS Smoke" \
  --keep

# Exercise Tailscale installation too. Use TS_AUTHKEY for unattended tailscale up.
npm run smoke:vps:aws -- --tailscale --tailscale-up
```

Phone-number pairing is an interactive smoke path. The runner strips non-digits
from `--whatsapp-phone`, starts account 1 through the built-in bridge, prints
the temporary pairing code as `whatsapp_pairing_code=...`, and keeps polling
until the phone approves the linked device. After pairing, the optional
`--create-whatsapp-thread` step creates a thread bound to the account's
self-chat so the operator can send a message to "Message yourself" in WhatsApp
and verify inbound routing. Use `--keep` when a human will test the live VPS;
otherwise the disposable AWS resources are deleted as soon as the smoke exits.

Operational notes from the phone-link smoke:

- Pairing codes rotate. Use the most recent `whatsapp_pairing_code=...` line.
- The readiness log is streamed through `tee` to both stdout and
  `/tmp/orkestr-whatsapp-readiness.log`, because this flow requires a human to
  see the code before the smoke exits.
- After a code is accepted, the bridge can briefly report `authenticating`.
  That means WhatsApp accepted the linked device and Orkestr is waiting for
  WhatsApp Web to finish becoming ready.
- If the bridge is active during service shutdown, Orkestr destroys the local
  WhatsApp browser clients before closing the server so `systemctl restart
  orkestr` does not hang on a stale Chrome/Puppeteer runtime.

### Lower-Level Systemd Installer

If the host is already prepared and you do not want the bootstrap checks or
Tailscale/Caddy helpers, call the lower-level installer directly:

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

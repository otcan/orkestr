# Framework And Deployment

Orkestr is split into two deployable layers:

- NestJS API in `apps/server`.
- Static web app served from `dist/web/browser`.
- Angular source in `apps/web/src` for contributors who change the UI.

The NestJS process serves both `/api/*` routes and the checked-in static web
bundle. Normal installs do not install Angular or build the web app. They install
runtime Node dependencies, install only the small TypeScript toolchain needed to
compile the server, verify `dist/web/browser`, and start serving it.

## Local Development

```bash
npm install
npm run dev
```

`npm run dev` builds the Angular app once and starts the NestJS server with the
browser-open flag. Re-run `npm run web:build` after frontend changes and commit
the updated `dist/web` bundle when the served UI should change.

## Verification

```bash
npm run check
npm run smoke
npm run demo:coding-agent
```

`npm run check` performs JavaScript syntax checks, compiles the NestJS backend,
builds the Angular contributor source into the served static bundle, and runs
the Node test suite.

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

Use the local installer for development and the host-native systemd installer
for a VPS. Caddy, Tailscale, browser desktops, systemd logs, SSH pairing
approval, and long-running agent work are host-level operations. Running the
server directly under the host keeps those operations plain.

Use these paths for different kinds of work:

- Trying Orkestr locally: `scripts/install.sh`. This installs a local user
  service by default: macOS `launchd`, Linux user `systemd`, or cron fallback.
- Running a real personal VPS: `scripts/bootstrap-vps.sh`.
- Installing on a host you already prepared: `scripts/install.sh --systemd`.
- Updating a VPS: `orkestr-update` or `orkestr update`.
- Testing installer or remote-access changes: `npm run smoke:vps:aws`.
- Publishing a production-like VPS version: versioned git release deploys.

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
- runs `scripts/install.sh --systemd --track-main`
- configures main-tracking versioned releases under `/opt/orkestr/releases`
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
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/bootstrap-vps.sh | sudo bash -s -- --domain orkestr.example.com --email admin@example.com

# Public HTTPS domain with Caddy client-certificate verification.
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/bootstrap-vps.sh | sudo bash -s -- --domain orkestr.example.com --email admin@example.com --mtls-ca /etc/orkestr/client-ca.pem

# Tailscale unattended setup. Prefer a secret manager; this interactive form avoids shell history.
read -rsp "Tailscale auth key: " TS_AUTHKEY; echo
export TS_AUTHKEY
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/bootstrap-vps.sh | sudo -E bash
unset TS_AUTHKEY

# Custom fork, branch, tag, or commit.
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/bootstrap-vps.sh | sudo bash -s -- --repo https://github.com/you/orkestr.git --ref main
```

### Public Domain Smoke

The Caddy path is alpha-ready when it is fronted by a real owned domain. Do not
use a shared dynamic DNS root such as `sslip.io` for release validation; public
ACME rate limits apply to the registered domain and can fail unrelated tests.

After setting the domain's A record to the VPS public IP and running
`bootstrap-vps.sh --domain`, run:

```bash
npm run smoke:public-domain -- \
  --domain orkestr.example.com \
  --host <vps-public-ip> \
  --ssh root@<vps-public-ip>
```

The smoke checks public DNS, HTTP-to-HTTPS redirects, the issued certificate,
the `/setup` page, that raw `19812` is not publicly reachable, that protected
API routes return `401 browser_pairing_required` before pairing, and that the
SSH-approved browser-pairing flow can access a protected API route with a
cookie. By default it revokes the temporary browser session before exiting.
Pass `--keep-session` only when you want to keep that paired browser.

Versioned deploys run a smaller public exposure gate automatically after the
service restart when a public app URL is configured. That deploy gate checks
multiple private API routes without cookies and refuses to mark the deploy
healthy unless each route returns `401`. The broader public-domain smoke remains
the full domain, certificate, pairing, and raw-port validation path.

When the Caddy site is protected with mTLS, pass the client certificate used by
the operator browser. The smoke first confirms that `/setup` is not reachable
without a client certificate, then repeats the normal HTTPS and browser-pairing
checks with the certificate:

```bash
npm run smoke:public-domain -- \
  --domain orkestr.example.com \
  --host <vps-public-ip> \
  --ssh root@<vps-public-ip> \
  --expect-mtls \
  --mtls-client-cert ./operator-client.pem \
  --mtls-client-key ./operator-client-key.pem
```

Useful cleanup commands:

```bash
orkestr security sessions
orkestr security revoke <session-id>
orkestr security revoke all
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
- If `authenticating` does not become `paired` within the auth-ready timeout
  (`WA_AUTH_READY_TIMEOUT_MS`, default 180 seconds), Orkestr marks the bridge
  failed, records the latest WhatsApp Web state/loading diagnostics, and
  destroys the local Chrome client so the VPS does not sit in a CPU-bound
  half-linked state.
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
orkestr status
orkestr logs
orkestr security approve <challenge-id>
orkestr security challenges
orkestr security sessions
orkestr security revoke <session-id|all>
```

The generated `/usr/local/bin/orkestr` wrapper can be run from a root SSH
session. It switches to `ORKESTR_RUN_USER` before reading or writing local
Orkestr state, which keeps `ORKESTR_HOME` owned by the same user that runs
`orkestr.service`.

## On-Box Update Watcher

For a personal VPS, prefer a small host-local updater over an external deploy
pipeline:

```bash
curl -fsSL https://raw.githubusercontent.com/otcan/orkestr/main/scripts/install.sh | sudo bash -s -- --systemd --track-main
```

`--track-main` installs the updater and configures versioned main tracking:

```text
/usr/local/bin/orkestr-update
/etc/systemd/system/orkestr-update.service
/etc/systemd/system/orkestr-update.timer
/usr/local/bin/orkestr-codex-app-server
/etc/systemd/system/orkestr-codex.service
ORKESTR_RELEASE_DEPLOY=1
ORKESTR_UPDATE_REF=main
ORKESTR_DEPLOY_CHANNEL=main
ORKESTR_DEPLOY_TAGS_ONLY=0
```

The timer runs every two minutes by default. Each run fetches the configured
repo, resolves `ORKESTR_UPDATE_REF` (default: `main`), exits if the active
release is already current, and otherwise builds a release directory named
`main-<short-commit>`. It then switches `/opt/orkestr/current`, restarts the
service, and verifies `/api/health`.

The older in-place updater is still available with `--auto-update` and no
`--release-updates`/`--track-main`. It exits if the checkout is already current
and otherwise runs:

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
orkestr status
orkestr version
sudo orkestr update
sudo orkestr rollback
orkestr logs
orkestr doctor
```

Advanced updater commands:

```bash
systemctl list-timers orkestr-update.timer
journalctl -u orkestr-update -f
orkestr update status
sudo orkestr update --track-main --no-smoke
sudo orkestr update --release --ref v0.1.7 --channel production
orkestr-update
orkestr-deploy status
orkestr-reset-state
```

## Versioned Git Releases

The update watcher can stay in the original in-place mode, but VPS installs
that need rollback should use the versioned release path. For main tracking:

```bash
ORKESTR_RELEASE_DEPLOY=1
ORKESTR_UPDATE_REF=main
ORKESTR_DEPLOY_CHANNEL=main
ORKESTR_DEPLOY_TAGS_ONLY=0
```

or:

```bash
sudo scripts/install.sh --systemd --track-main
sudo orkestr update
```

For strict tagged production releases:

```bash
ORKESTR_RELEASE_DEPLOY=1
ORKESTR_UPDATE_REF=v0.1.7
ORKESTR_DEPLOY_CHANNEL=production
ORKESTR_DEPLOY_TAGS_ONLY=1
```

With `ORKESTR_RELEASE_DEPLOY=1`, `orkestr-update` delegates to
`scripts/deploy-git-release.sh`. The deployer:

- fetches git tags and resolves the requested ref to an exact commit
- requires an exact tag for the `production` channel unless
  `ORKESTR_DEPLOY_TAGS_ONLY=0`
- creates a fresh release directory under `/opt/orkestr/releases`
- runs `npm ci`, `npm run build`, and `npm run smoke`
- writes `release-manifest.json` into the release
- backs up `ORKESTR_HOME` under `/opt/orkestr/backups`
- keeps Codex app-server in a separate systemd service and connects through a
  local Unix-socket proxy, so active Codex turns survive UI/API restarts
- checks `/api/threads?scope=all` and refuses to restart only when unsafe
  in-process or legacy runtime work is active. First-time split migrations still
  wait for active work to become idle before the external Codex service is
  enabled.
- switches `/opt/orkestr/current` atomically
- stops and starts `orkestr.service` with a short delivery drain marker so new
  inputs queue instead of being delivered during the restart window
- verifies `/api/health`
- fans out by default to broker-listed release-train instances after the local
  host is healthy. The concrete instances and deploy commands live in private
  host state, not in the OSS repo.
- appends the result to `/opt/orkestr/deployments.json`

Manual operations:

```bash
sudo orkestr update
sudo orkestr rollback
sudo orkestr update --track-main --no-smoke
sudo orkestr update --track-main --no-smoke --wait-active
sudo orkestr update --release --ref v0.1.7 --channel production
sudo orkestr update --release --ref v0.1.7 --channel production --no-all-instances
orkestr update status
orkestr update rollback
orkestr-deploy install --ref main --channel main --allow-untagged --no-smoke
orkestr-deploy install --ref main --channel main --allow-untagged --no-smoke --wait-active
orkestr-deploy install --ref v0.1.7 --channel production
orkestr-deploy status
orkestr-deploy rollback
orkestr-deploy rollback --to v0.1.6
```

The release manifest is app-code metadata, not secrets. It records the app
version, requested ref, resolved commit, exact tag if present, describe string,
channel, release id, service name, and compatibility notes. Server-local
secrets stay in `/etc/orkestr/orkestr.env`, and mutable data stays in
`ORKESTR_HOME`.

`/api/version` reports release metadata when the app is launched from a
release directory or when `ORKESTR_RELEASE_MANIFEST` points to a manifest file.
Use that endpoint after every deploy and rollback to verify the active version.

### Managed And OSS Split

Operators that run both a managed/private Orkestr and an OSS proof deployment
should keep them as separate release tracks. They need distinct service names,
ports, `ORKESTR_HOME` directories, release roots, repo caches, public URLs, and
release manifests.

Generate a dry-run profile plan:

```bash
npm run deploy:split-plan -- --domain example.test --managed-repo <managed-private-repo-url>
npm run deploy:split-plan -- --shell --domain example.test --managed-repo <managed-private-repo-url>
```

The generated profiles set:

- `ORKESTR_DISTRIBUTION=managed` and `ORKESTR_DEPLOYMENT_TRACK=managed-production`
  for the private/operator deployment
- `ORKESTR_DISTRIBUTION=oss` and `ORKESTR_DEPLOYMENT_TRACK=oss-production` for
  the public-repo proof deployment

After each deploy, verify `/api/version` on both public URLs. The managed
instance should report `distribution.kind=managed`; the OSS instance should
report `distribution.kind=oss`.

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
2. Run `npm run launch:check`.
3. Run `npm run check`.
4. Run `npm run smoke`.
5. Run `npm run demo:coding-agent`.
6. Run `npm run smoke:vps:aws` for installer, systemd, updater, Caddy,
   Tailscale, or remote-access changes.
7. Review `README.md`, `docs/private-overlay.md`, and this file.
8. Tag and publish only after the private overlay has been checked for leaks.

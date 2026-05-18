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

Use Docker for local first-run demos and host-native systemd for a VPS.

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

## Continuous VPS Deploys

`.github/workflows/deploy-vps.yml` redeploys the host-native VPS after the `CI`
workflow succeeds on `main`. It also supports manual `workflow_dispatch`
redeploys. The workflow keeps private host details out of the repository and
uses GitHub repository secrets:

```text
ORKESTR_DEPLOY_HOST
ORKESTR_DEPLOY_SSH_KEY
ORKESTR_DEPLOY_ENABLED     set to 1 after the other secrets are ready
ORKESTR_DEPLOY_USER          optional, defaults to root
ORKESTR_DEPLOY_PORT          optional, defaults to 22
ORKESTR_DEPLOY_KNOWN_HOSTS   recommended
TAILSCALE_OAUTH_CLIENT_ID    optional, for tailnet-only hosts
TAILSCALE_OAUTH_SECRET       optional, for tailnet-only hosts
TAILSCALE_TAGS               optional, defaults to tag:ci
```

The deploy job checks out the commit that passed CI, optionally joins the
tailnet with `tailscale/github-action`, uploads `scripts/install.sh` over SSH,
sets `ORKESTR_GIT_REF` to the exact commit, and runs:

```bash
bash /tmp/orkestr-install-*.sh --systemd
```

The installer fetches that ref into `/opt/orkestr/app`, runs `npm ci`,
`npm run build`, prunes dev dependencies, writes the CLI and systemd unit, and
restarts `orkestr.service`. The existing `/etc/orkestr/orkestr.env` is kept, so
OpenAI keys, OAuth credentials, Caddy/Tailscale URLs, and private overlay paths
remain server-local.

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
by Compose; start from `.env.docker.example` for OpenAI,
Tailscale/Caddy, OAuth, workspace, and overlay settings. Private overlays are
mounted separately with `ORKESTR_OVERLAY_DIR`; do not bake secrets, WhatsApp
state, browser profiles, or personal prompts into the public image.

## Release Checklist

1. Confirm `git status --short` is clean.
2. Run `npm run check`.
3. Run `npm run smoke`.
4. Run `npm run demo:coding-agent`.
5. Run `npm run docker:build`.
6. Review `README.md`, `docs/private-overlay.md`, and this file.
7. Tag and publish only after the private overlay has been checked for leaks.

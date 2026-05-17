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

## Docker

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
container. `CODEX_HOME` defaults to `/data/codex`, so Codex device auth started
from the setup UI persists in the same Docker volume. Docker settings are read
from `.env` by Compose; start from `.env.docker.example` for OpenAI,
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

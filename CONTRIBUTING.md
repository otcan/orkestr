# Contributing

Orkestr OSS is public-facing. Treat every file, fixture, prompt, issue
reference, screenshot, and example as publishable.

## Start Here

Use this order when you are trying to understand or change the project:

1. [README.md](README.md): product promise, quickstart, supported install paths.
2. [docs/user-guide.md](docs/user-guide.md): user-facing concepts and workflows.
3. [docs/framework-deployment.md](docs/framework-deployment.md): VPS, installer, update, release, and smoke-test flows.
4. [SECURITY.md](SECURITY.md): remote access, browser pairing, and public/private boundary.
5. [docs/architecture.md](docs/architecture.md): package and runtime boundaries.
6. [docs/private-overlay.md](docs/private-overlay.md): where deployment-only behavior belongs.
7. [ROADMAP.md](ROADMAP.md): what is intentionally next or out of scope.

The repo has several automation paths. Prefer the documented scripts below
instead of inventing a new manual sequence.

## Local Setup

```bash
npm ci
npm run build
npm test
npm run demo:coding-agent
```

Use `npm run check` before opening a pull request. It runs syntax checks, the
server build, the web build, and the Node test suite.

## Automation Map

- `npm run build`: TypeScript server build plus Angular web build.
- `npm test`: full Node test suite.
- `npm run test:ci`: CI test runner with compact failure output.
- `npm run smoke`: local API/runtime smoke test with a temporary Orkestr home.
- `npm run demo:coding-agent`: deterministic fake-data demo; no real accounts.
- `npm run docker:build`: local Docker image build.
- `npm run launch:check`: public launch gate for docs/privacy/release readiness.
- `npm run smoke:vps:aws`: creates a disposable Ubuntu VPS, runs the bootstrap
  installer, executes the smoke test on that host, then cleans it up.

Useful VPS smoke variants:

```bash
npm run smoke:vps:aws -- --with-whatsapp
npm run smoke:vps:aws -- --tailscale --tailscale-up
npm run smoke:vps:aws -- --local-bootstrap --ref my-branch
npm run smoke:vps:aws -- --keep-on-failure
```

Use `scripts/bootstrap-vps.sh` for the opinionated fresh-server path. Use
`scripts/install.sh --systemd` only when the host is already prepared and you
want the lower-level installer directly. Use `scripts/deploy-git-release.sh`
and `scripts/update-watch.sh` for versioned release/update work.

## Install Path Expectations

There are two supported install shapes:

- Docker Compose for local/beginner testing.
- Host-native systemd for VPS installs.

The host-native path should work out of the box for protected remote access:
Orkestr stays bound to `127.0.0.1`, browser pairing is enabled by default, and
Tailscale/Caddy can provide the remote entrypoint. Do not document or implement
a flow that exposes the raw Orkestr service, terminal streams, or API directly
to the public internet.

## Public/Private Boundary

Do not commit:

- secrets, API keys, OAuth tokens, cookies, or QR session state
- real WhatsApp chat IDs or phone numbers
- private hostnames, VPS names, home directory assumptions, or deployment-only paths
- personal browser profiles
- personal prompts, timers, or client data
- private Codex launch/session scripts

Generic code belongs in this repo. Host-specific behavior belongs in a private
overlay loaded with `ORKESTR_OVERLAY_DIR`.

## Scope

V1 is intentionally small:

- setup UI
- OpenAI and Codex checks
- Gmail
- LinkedIn virtual browser
- WhatsApp
- virtual browsers
- timers
- thread-first coding-agent runtime

Avoid enterprise/team/plugin abstractions until the first onboarding loop is
reliable.

## Code Style

- Keep files small and purpose-specific.
- Prefer existing local helpers and patterns.
- Add tests when behavior changes.
- Keep public examples deterministic and fake.
- Use ASCII unless a file already needs non-ASCII.

## Pull Request Checklist

- `npm run check` passes.
- `npm run smoke` passes for runtime/setup changes.
- `npm run demo:coding-agent` passes for demo or onboarding changes.
- `npm run docker:build` passes for Docker/runtime dependency changes.
- `npm run smoke:vps:aws` passes for installer, systemd, updater, Caddy,
  Tailscale, or remote-access changes.
- README/docs stay free of private details.
- New public examples use fake IDs and generic hosts.
- UI changes keep the install path boring: install, start, open setup, connect
  accounts, create a thread.

# Original Alpha Release Plan

This document records the original publish gate for `v0.1.0-alpha.0`. For the
current release checklist, use [framework-deployment.md](framework-deployment.md)
and [CONTRIBUTING.md](../CONTRIBUTING.md).

## Public Promise

Orkestr alpha is a self-hosted agent workstation scaffold:

- install locally
- open the setup UI
- configure connector surfaces
- create a named thread
- route mock WhatsApp-origin work
- schedule timers
- keep private credentials and host-specific runtime behavior outside the public repo

## Publish Criteria

- `git status --short` is clean.
- `npm run launch:check` passes.
- `npm run check` passes.
- `npm run smoke` passes.
- `npm run demo:coding-agent` passes.
- `npm run docker:build` passes.
- Privacy scan finds no real hostnames, WhatsApp IDs, tokens, browser profiles, personal prompts, or private deployment paths.
- `README.md`, `.env.example`, `docs/private-overlay.md`, and `CHANGELOG.md` describe the public/private split.

## Privacy Scan

Use this as a broad first pass, then review results manually:

```bash
rg -n "private-domain|private-host|real-chat-id|@g\\.us|/root/|/home/|sk-[A-Za-z0-9]|GOCSPX|client_secret|refresh_token|access_token" \
  --glob '!node_modules/**' \
  --glob '!dist/**' \
  --glob '!.git/**'
```

Expected allowed hits are only fake test tokens, fake demo chat ids, generic docs, or implementation field names.

## Release Commands

```bash
npm ci
npm run launch:check
npm run check
npm run smoke
npm run demo:coding-agent
npm run docker:build
git status --short
git tag -a v0.1.0-alpha.0 -m "v0.1.0-alpha.0"
```

Push only after reviewing the diff and tag contents.

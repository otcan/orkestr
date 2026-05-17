# Contributing

Orkestr OSS is public-facing. Treat every file, fixture, prompt, issue reference, and example as publishable.

## Local Setup

```bash
npm ci
npm run build
npm test
npm run demo:coding-agent
```

Use `npm run check` before opening a pull request. It runs syntax checks, the server build, the web build, and the Node test suite.

## Public/Private Boundary

Do not commit:

- secrets, API keys, OAuth tokens, cookies, or QR session state
- real WhatsApp chat IDs or phone numbers
- private hostnames, VPS names, home directory assumptions, or deployment-only paths
- personal browser profiles
- personal prompts, timers, or client data
- private Codex launch/session scripts

Generic code belongs in this repo. Host-specific behavior belongs in a private overlay loaded with `ORKESTR_OVERLAY_DIR`.

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

Avoid enterprise/team/plugin abstractions until the first onboarding loop is reliable.

## Code Style

- Keep files small and purpose-specific.
- Prefer existing local helpers and patterns.
- Add tests when behavior changes.
- Keep public examples deterministic and fake.
- Use ASCII unless a file already needs non-ASCII.

## Pull Request Checklist

- `npm run check` passes.
- `npm run demo:coding-agent` passes.
- README/docs stay free of private details.
- New public examples use fake IDs and generic hosts.
- UI changes keep the install path boring: install, start, open setup, connect accounts, create a thread.

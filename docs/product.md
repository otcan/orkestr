# Product

## One-Line Pitch

Run local coding agents with WhatsApp, browser desktops, timers, and inspectable logs.

## First User Journey

1. Install Orkestr.
2. Open `/setup`.
3. Connect Codex.
4. Pair WhatsApp 1 with the built-in local bridge.
5. Prepare the Virtual Desktop profile.
6. Create the first coding thread.
7. Send a task from the web UI, CLI, or WhatsApp.
8. Attach to the local Codex session.
9. Inspect the result and activity log.

## Default Starter

The public starter is a coding-agent loop:

- one Orkestr thread maps to one local Codex runtime
- messages can be queued from the web UI, CLI, or WhatsApp
- the virtual desktop profile is prepared for browser-based work
- timers can queue recurring work later

Run the deterministic public demo:

```bash
npm run demo:coding-agent
```

Run the real local Codex example:

```bash
npx orkestr-oss thread create "Repo launch reviewer" --id repo-launch-reviewer --cwd "$PWD" --executor codex
npx orkestr-oss wake repo-launch-reviewer
npx orkestr-oss send repo-launch-reviewer "Inspect this repo and list launch blockers. Do not edit files."
npx orkestr-oss attach repo-launch-reviewer
```

## V1 Boundaries

In:

- local setup
- public monorepo structure
- private overlay loading
- persistent connector config
- connector checks
- virtual browser profiles
- WhatsApp connector surface
- thread runtime records
- Codex CLI runtime handoff
- timers
- local activity events
- Docker local deployment

Out:

- enterprise teams
- plugin marketplace
- Slack/Discord
- Kubernetes as a required install path
- multi-tenant hosting
- private host assumptions

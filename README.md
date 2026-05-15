# Orkestr

Orkestr is a local-first personal agent workstation.

Install once, connect your accounts, message agents from WhatsApp, watch their virtual browsers, and schedule recurring work.

## V1 scope

- Setup wizard
- OpenAI and Codex connection checks
- Connector config persistence for OpenAI, Gmail, and WhatsApp
- Gmail connector surface
- LinkedIn virtual browser surface
- WhatsApp bridge surface
- Virtual browser registry
- Agent starter templates
- Timers and manual timer runs
- Local activity log

Nothing else is in scope for V1.

## Quickstart

```bash
git clone <repo-url> orkestr
cd orkestr
npm start
```

Open:

```text
http://127.0.0.1:19812
```

Optional environment:

```bash
export OPENAI_API_KEY=sk-...
export CODEX_HOME="$HOME/.codex"
export WHATSAPP_BRIDGE_URL="http://127.0.0.1:8787"
export ORKESTR_HOME="$HOME/.orkestr"
export ORKESTR_OVERLAY_DIR="/path/to/private-overlay"
```

Docker:

```bash
docker compose up --build
```

## Product promise

Give your AI agent:

- a browser
- WhatsApp
- Gmail
- LinkedIn
- a schedule

The default demo is a job-search assistant that checks Gmail and LinkedIn and sends WhatsApp summaries.

## Current skeleton

This repo is intentionally dependency-free for the first scaffold. It provides:

- `apps/server`, `apps/web`, `apps/cli`, and `packages/*` as the public monorepo boundary.
- `GET /api/setup/status` for local connector health.
- `GET /api/health`, `GET /api/ready`, and `GET /api/version`.
- `ORKESTR_OVERLAY_DIR` for loading a private runtime overlay.
- `POST /api/connectors/:id/config` for storing connector settings under `ORKESTR_HOME`.
- `GET /api/connectors/gmail/oauth/start` and `/oauth/gmail/callback` as the Gmail OAuth skeleton.
- `GET /api/browsers` plus prepare/open actions for owned browser profiles.
- `GET /api/agents/templates` and `POST /api/agents/templates/:id` for first agent creation.
- `GET/POST /api/agents/:id/messages` for local agent inbox/history.
- `POST /api/agents/:id/run-next`, `GET /api/executors`, and `GET /api/executions` for the generic executor boundary.
- Overlay executor module loading so private deployments can add a real Codex adapter without public host assumptions.
- `GET/POST /api/timers`, `POST /api/timers/:id/run`, and `DELETE /api/timers/:id`.
- `GET /api/events` for setup and scheduler activity.

Still private-overlay territory: real Codex session orchestration, real browser automation against logged-in profiles, and production WhatsApp bridge hosting. Public code keeps generic APIs and mockable examples; private deployments provide host-specific executors, credentials, profiles, and bridge processes.

## Development

```bash
npm run check
npm run smoke
npm run demo:job-search
```

## Job-search demo

The first end-to-end demo is dependency-free and uses only fake data:

```bash
npm run demo:job-search
```

It starts Orkestr with `examples/job-search-demo`, starts a mock WhatsApp bridge,
creates the `job-search-assistant`, receives a fake WhatsApp message, runs the
demo executor, and verifies that the assistant reply is mirrored back to the
mock bridge exactly once.

See `docs/private-overlay.md` for the public/private repo boundary.

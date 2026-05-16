# Orkestr

Orkestr is a local-first personal agent workstation.

Install once, connect your accounts, message agents from WhatsApp, watch their virtual browsers, and schedule recurring work.

> Status: `0.1.0-alpha.0`. This is an early public alpha scaffold. It is useful
> for local development, demos, and private-overlay integration; it is not a
> hosted multi-user product.

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
npm install
npm run build
npm start
```

Open:

```text
http://127.0.0.1:19812
```

Optional environment can be copied from `.env.example`:

```bash
cp .env.example .env
```

The public repo does not include real credentials, browser profiles, WhatsApp
session state, hostnames, or personal prompts. Put those in a private overlay and
load it with `ORKESTR_OVERLAY_DIR`.

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

## Current alpha surface

This repo is a NestJS API plus Angular web app. It provides:

- `apps/server` as the NestJS API, `apps/web/src` as the Angular UI, `apps/cli`, and `packages/*` as the public monorepo boundary.
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
- `packages/shared` for framework-neutral API contracts used by the NestJS API and future Angular services.
- `GET/POST /api/timers`, `POST /api/timers/:id/run`, and `DELETE /api/timers/:id`.
- `GET /api/events` for setup and scheduler activity.
- Thread-first runtime APIs: `GET/POST /api/threads`, `POST /api/threads/:id/input`,
  `GET /api/threads/:id/messages`, `GET /api/threads/:id/history`,
  `POST /api/threads/:id/wake`, `POST /api/threads/:id/sleep`,
  `POST /api/threads/:id/approve`, `POST /api/threads/:id/interrupt`,
  `POST /api/threads/:id/uploads`, and per-thread timers.

Still private-overlay territory: production credentials, real browser automation
against logged-in profiles, production WhatsApp bridge hosting, and any
host-specific executor behavior. Public code keeps generic APIs and mockable
examples; private deployments provide credentials, profiles, bindings, and
bridge processes.

## Development

```bash
npm install
npm run dev
```

`npm run dev` builds the Angular UI once, starts the NestJS API, and serves the
built UI from `dist/web/browser`.

Before pushing or releasing:

```bash
npm run check
npm run smoke
npm run demo:job-search
```

`npm run check` includes syntax checks, the Angular production build, and the
Node test suite.

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
See `docs/alpha-release.md` for the alpha release gate.
See `docs/framework-deployment.md` for the NestJS, Angular, and Docker deployment flow.
See `docs/milestone-2-release.md` for the current release checklist.

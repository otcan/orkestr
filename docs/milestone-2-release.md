# Milestone 2 Release Checklist

Milestone 2 turns the scaffold into a usable public baseline for the first Orkestr loop:

1. create a coding-agent thread
2. prepare the virtual desktop profile
3. queue repository work
4. wake the host-native Codex runtime when the operator is ready
5. persist messages, runtime state, timers, and events
6. keep private host behavior outside the public repo

The public repo remains generic. Real credentials, WhatsApp IDs, browser profiles, personal prompts, and host-specific Codex launch behavior belong in a private overlay loaded with `ORKESTR_OVERLAY_DIR`.

## Included

- Private overlay loading with executor adapter registration.
- Generic executor boundary plus no-op executor.
- Gmail OAuth start, callback, token exchange, refresh, failure tracking, and inbox read APIs.
- WhatsApp bridge status, inbound routing, event-id dedupe, and final text reply delivery through `/send-text`.
- Stable `coding-agent` starter id.
- Deterministic public coding-agent demo.
- Automated demo smoke test in `node:test`.
- Local smoke test for persistence, timers, executor output, and activity events.

## Verification

Run these before tagging or publishing:

```bash
npm run launch:check
npm run check
npm run smoke
npm run demo:coding-agent
```

Expected result:

- `npm run launch:check` passes the grouped launch gate.
- `npm run check` passes all unit and end-to-end tests.
- `npm run smoke` proves persisted timers/messages/events survive restart.
- `npm run demo:coding-agent` proves the public coding-agent setup loop.

## Manual Demo

```bash
npm run demo:coding-agent
```

The demo starts Orkestr with a temporary local home, creates `demo-coding-agent`, prepares the virtual desktop profile, queues a repo-inspection task, and prints the next real Codex step.

## API Surface To Keep Stable

- `GET /api/setup/status`
- `GET /api/connectors/gmail/oauth/start`
- `GET /oauth/gmail/callback`
- `GET /api/connectors/gmail/messages`
- `GET /api/connectors/gmail/messages/:id`
- `GET /api/connectors/whatsapp/status`
- `POST /api/connectors/whatsapp/inbound`
- `POST /api/connectors/whatsapp/deliver`
- `GET/POST /api/agents/:id/messages`
- `POST /api/agents/:id/run-next`
- `GET/POST /api/threads`
- `POST /api/threads/:id/input`
- `POST /api/threads/:id/wake`
- `GET/POST /api/timers`
- `POST /api/timers/:id/run`
- `GET /api/browser-sessions`
- `POST /api/browser-sessions/:slug/:action`
- `GET /api/events`

## Private Overlay Contract

Private overlays can provide:

- executor modules under `executors.modules`
- a default executor id under `executors.default`
- connector config loaded through normal setup APIs
- private agent/timer seed data in future migration tooling

Private overlays must not be copied into the public repo when they contain:

- OAuth tokens or client secrets
- WhatsApp chat ids or session state
- browser profile paths
- personal prompt files
- hostnames or deployment-only service names
- customer or business data

## Known Gaps

- Secure remote access has an out-of-box baseline path through localhost bind, browser pairing, and optional Tailscale/Caddy, with disposable VPS smoke coverage; deeper validation and polish remain.
- The public demo queues a coding-agent task; local and VPS host-native setup
  both provide a Codex runtime path, and real Codex runs depend on completing
  setup-page device authorization.
- WhatsApp media mirroring is not included in this milestone; final text replies are covered.
- The public UI is still a setup workstation, not a full production operations console.

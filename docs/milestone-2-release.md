# Milestone 2 Release Checklist

Milestone 2 turns the scaffold into a usable public baseline for the first
Orkestr loop:

1. create the job-search assistant
2. receive a WhatsApp-origin message
3. queue it in the agent inbox
4. run an executor through the overlay boundary
5. persist the assistant reply
6. mirror the final reply back through the WhatsApp bridge

The public repo remains generic. Real host-specific Codex launch behavior,
personal prompts, credentials, WhatsApp IDs, browser profiles, and timers belong
in a private overlay loaded with `ORKESTR_OVERLAY_DIR`.

## Included

- Private overlay loading with executor adapter registration.
- Generic executor boundary plus no-op executor.
- Gmail OAuth start, callback, token exchange, refresh, failure tracking, and
  inbox read APIs.
- WhatsApp bridge status, inbound routing, event-id dedupe, and final text reply
  delivery through `/send-text`.
- Stable `job-search-assistant` starter id.
- Deterministic public job-search demo overlay.
- Automated demo smoke test in `node:test`.
- Local smoke test for persistence, timers, executor output, and activity events.

## Verification

Run these before tagging or publishing:

```bash
npm run check
npm run smoke
npm run demo:job-search
docker build -t orkestr-oss:test .
```

Expected result:

- `npm run check` passes all unit and end-to-end tests.
- `npm run smoke` proves persisted timers/messages/events survive restart.
- `npm run demo:job-search` proves the mock WhatsApp-to-agent-to-WhatsApp loop.
- `docker build` proves the production image builds Angular and can start from
  compiled assets.

## Manual Demo

```bash
npm run demo:job-search
```

The demo starts a mock WhatsApp bridge, starts Orkestr with
`examples/job-search-demo`, creates `job-search-assistant`, injects a fake
WhatsApp message, runs the demo executor, and verifies exactly one mirrored
reply was sent back to the mock bridge.

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
- `GET/POST /api/timers`
- `POST /api/timers/:id/run`
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

- Real Codex session orchestration belongs to a private executor adapter for now.
- Gmail and LinkedIn reasoning is not yet an autonomous production assistant in
  the public repo; the demo executor is deterministic by design.
- WhatsApp media mirroring is not included in this milestone; final text replies
  are covered.
- The public UI is still a setup workstation, not a full production operations
  console.

## Release Steps

1. Confirm `git status --short` is clean.
2. Run the verification commands above.
3. Review `README.md`, `docs/product.md`, `docs/framework-deployment.md`, and this checklist.
4. Create a signed or annotated tag, for example `v0.1.0-alpha.0`.
5. Push `main` and the tag.
6. Create release notes from the included scope and known gaps.

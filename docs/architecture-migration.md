# Architecture Migration Runbook

This runbook stages the architecture migration tracked by Jira epic ORK-171.
The goal is to shrink high-risk files and create enforceable boundaries without
changing user-visible Orkestr behavior in one large rewrite.

## Phase 1: Guardrails And Contracts

Scope:

- Add ADR 0001 and link it from architecture docs.
- Add architecture tests for package dependency direction and new oversized
  files.
- Add the shared Orkestr event contract.

Verification:

```bash
node --test test/architecture.test.js test/turn-lifecycle.test.js
npm run build:server
```

Rollback:

- Revert only docs, `test/architecture.test.js`, and
  `packages/core/src/orkestr-events.js`.

## Phase 2: WhatsApp Boundary Extraction

Scope:

- Extract formatting and debug footer code.
- Extract mirror policy decisions.
- Extract delivery ledger, claim, key, and retention code.
- Then split inbound routing from outbound mirroring.

Verification:

```bash
node --test test/whatsapp.test.js
npm run build:server
```

Rollback:

- Revert only `packages/connectors/src/whatsapp-*` extraction commits.
- Do not mix runtime changes into this phase.

## Phase 3: Runtime Boundary Extraction

Scope:

- Route app-server behavior through a Codex runtime adapter.
- Quarantine legacy tmux code behind an explicitly named legacy adapter.
- Remove sleep/wake wording from app-server-only logic where the API already
  has turn/stop semantics.

Verification:

```bash
node --test test/codex-app-server.test.js test/thread-control-delivery.test.js test/tmux-runtime.test.js
npm run build:server
```

Rollback:

- Revert runtime adapter changes only. Keep event and WhatsApp boundaries.

## Phase 4: Storage Repositories

Scope:

- Wrap current JSON/SQLite state behind repositories.
- Keep file formats unchanged.
- Move message mutation queueing into repository code after thread/message
  access is consistently routed through repositories.

Verification:

```bash
node --test test/storage.test.js test/threads.test.js
npm run build:server
```

## Phase 5: Server And API Contracts

Scope:

- Split large NestJS controllers into thin HTTP adapters and use-case services.
- Replace broad `Record<string, unknown>` request handling with shared DTO
  schemas for high-traffic routes first.

Verification:

```bash
node --test test/server-api.test.js test/api-schemas.test.js
npm run build:server
```

## Phase 6: Angular UI State

Scope:

- Split the root component into shell, sidebar, chat, composer, runtime status,
  settings, workers, Git badge, and WhatsApp binding components.
- Move state into feature-level Angular signal stores.

Verification:

```bash
npm run web:build
node --test test/static-ui.test.js test/message-renderer.test.js test/thread-wizard.test.js
```

## Release Rules

- Each phase should land as a separate PR/worker merge.
- Do not combine WhatsApp delivery changes with runtime delivery changes.
- Run `npm run build` and the affected targeted suites before a release train.
- For production-like deploys, follow `docs/release-train.md` and verify
  WhatsApp mirroring plus Codex app-server turn control after deployment.

## Current Checkpoint: Ready For Release Prep

This checkpoint intentionally stops before release/deploy. Before tagging or
deploying it, confirm the working tree contains one coherent migration commit
covering:

- WhatsApp: inbound routing, outbound mirror worker/policy, delivery ledger,
  formatting, debug footer, and table attachment boundaries.
- Runtime: Codex app-server adapter, legacy tmux adapter, and no app-server
  sleep/wake queue wording.
- Storage: thread/message/timer/user repository wrappers with unchanged backing
  formats.
- Server: request schema validation plus split worker/repo/timer controllers.
- Web: Angular signal stores plus extracted message-list component.

Release-prep verification:

```bash
npm run build:server
npm run web:build
node --test --test-concurrency=1 test/whatsapp-boundaries.test.js test/whatsapp.test.js test/api-schemas.test.js test/architecture.test.js test/tmux-runtime.test.js
node --test --test-concurrency=1
git diff --check
```

Manual smoke before deployment:

- Open the Angular UI and verify chat loading, sending, and plan message actions.
- Send a WhatsApp-routed message and confirm one update/final mirror only.
- Send `/now <message>` to a working Codex app-server thread and confirm it is
  treated as turn interruption, not a wake-from-sleep flow.
- Confirm timers and worker creation still work from the split thread routes.

# ADR 0001: Orkestr Architecture Boundaries

Status: accepted

## Context

Orkestr has grown around live operational needs. The current code works, but a
few files own too many responsibilities:

- `packages/core/src/runtime-leases.js` mixes legacy tmux leases, Codex
  app-server control, input delivery, rollout import, reset, recovery, and
  progress sampling.
- `packages/connectors/src/whatsapp.js` mixes WhatsApp status, inbound routing,
  outbound mirroring, formatting, duplicate suppression, delivery claims, queue
  notices, and typing.
- `apps/server/src/modules/threads/threads.controller.ts` mixes HTTP handling
  with thread use cases, workspace prep, runtime control, workers, uploads, and
  timers.
- `apps/web/src/app/app.component.ts` owns most of the Angular application
  state.

This makes small fixes risky because product behavior is inferred by scanning
messages, runtime records, connector state, and transport ledgers in multiple
places.

## Decision

Orkestr will move toward explicit package boundaries without a rewrite.

Target dependency direction:

```text
domain -> application -> adapters

apps/server -> application + adapters
apps/web    -> shared API contracts
apps/cli    -> application API/HTTP client

adapters:
  storage
  runtime-codex
  runtime-tmux-legacy
  connectors
  browsers
```

Core domain and application code must not depend directly on connector
implementation details. Runtime and connector implementations should depend on
ports/contracts, not on each other's private state.

The migration is staged:

1. Add architecture guardrails and event contracts.
2. Split WhatsApp formatting, delivery ledger, inbound routing, and outbound
   mirroring.
3. Split Codex app-server runtime from legacy tmux runtime.
4. Introduce repositories around the existing JSON/SQLite state.
5. Move NestJS controller logic into application services.
6. Split the Angular root component into feature components and signal stores.

The operational phase checklist lives in
[Architecture Migration Runbook](../architecture-migration.md).

## Event Contract

Long-running behavior should use explicit events instead of hidden state scans
where practical. Canonical event families include:

- `thread.input.queued`
- `runtime.turn.started`
- `runtime.needs_approval`
- `assistant.progress.imported`
- `assistant.final.imported`
- `thread.input.delivered`
- `thread.input.failed`
- `whatsapp.mirror.requested`
- `whatsapp.mirror.delivered`
- `typing.state.changed`
- `timer.due`
- `worker.created`

Events must have stable idempotency keys when they can be replayed or observed
from external transports.

## Constraints

- No big-bang rewrite.
- Preserve route URLs and public CLI behavior during extraction.
- Preserve current file formats until repositories are in place.
- Keep private host assumptions out of the OSS repo.
- Legacy tmux compatibility may remain only as an explicitly named legacy
  adapter for migration and cleanup.

## Consequences

New code should be smaller and easier to test. During the migration some
allowlisted legacy imports and large files will remain, but new violations
should fail architecture tests unless they are explicitly documented.

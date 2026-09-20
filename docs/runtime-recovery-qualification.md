# Runtime recovery qualification

These commands inspect persisted repository records without history hydration,
agent submission, connector sends, or replay. Run them only for an authorized
owner and exact thread. Keep reports outside the repository: they contain scoped
record identifiers. Both audit CLIs require an explicit `ORKESTR_HOME`. Console output contains counts and a snapshot digest, not
message text, attachment paths, or provider error payloads.

## Question audit

```sh
node scripts/codex-question-audit.mjs \
  --thread example-thread --owner example-owner --generation example-generation \
  --max-messages 10000 --report /private/question-audit.json
```

The generation must match the current native app-server runtime. Terminal/tmux
threads are rejected. A legacy rollout question without a request identifier is
a review candidate only when no persisted request is pending. Native requests
must match generation, turn and request ID. Resolved records, missing identity,
conflicting generations and pending requests are reported separately. Duplicate
record IDs cannot qualify as unique candidates. The inventory bound fails closed
instead of silently auditing a truncated tail.

This command has no apply mode and does not answer questions, clear runtime state
or change normal input steering. A report describes persisted state, not a live
protocol probe. Review the exact targets and reconcile under an explicitly
approved operation; do not treat the digest as permission to change history.

## Incident delivery audit

```sh
node scripts/whatsapp-recovery-audit.mjs \
  --thread example-thread --owner example-owner --account example-account \
  --chat example-chat --generation example-generation \
  --since 2026-01-01T00:00:00Z --until 2026-01-01T01:00:00Z \
  --report /private/delivery-audit.json
```

Every row is marked `automaticReplay: false`; `eligible` means eligible for exact
operator review, not authorization to send. `replayed` is always zero. Pending
rows alone do not prove missing delivery. Partial, uncertain and in-flight jobs
remain unresolved. Only explicit bridge availability codes can qualify; known
401/403/404 failures remain unresolved. Source revisions and payload hashes must
match for duplicate classification. Separate canonical projections additionally
require their durable trace and body identity. Changed revisions and competing
undelivered records are not selected for recovery.

The report examines up to 10,000 final jobs and 100,000 messages. If the outbox
reports more rows than returned, no undelivered row qualifies. Historical
retention may have removed evidence, so a complete current inventory does not
establish complete historical delivery knowledge. Missing evidence stays
unresolved. No attachment bytes are opened, transport hooks called, shadows
rewritten or deduplication keys changed.

## Attended runtime gate

```sh
node scripts/runtime-control-release-gate.mjs --input /private/runtime-evidence.json --attended
```

All six numeric measurements are required. Missing, nonnumeric, negative or
nonfinite observations fail; counts must be integers. Without `--attended`, the
result is labelled `measurements_only` and cannot establish rollout acceptance.

Attended mode additionally requires `canaryEvidence` with `version: 1`, a
`releaseId`, `startedAt`, `completedAt`, distinct named `canaries` for both
`internal` and `tenant` stages, and an observed `rollback`. Each canary must bind
the release, private scope/evidence references, a completed terminal disposition,
persisted final message, delivery acceptance receipt/time, and observed stop,
steering and checkpoint resume. Rollback must identify a different restored
release, healthy result and observation within the same window.

The validator checks evidence consistency and completeness. It does not create
canaries, authenticate operator assertions or replace review of the referenced
observations. Synthetic passing evidence in tests is not operational acceptance.

## Historical input repair

The existing input repair report/apply/rollback tool remains approval-digest and
revision fenced. Generate a fresh report after upgrading: conflicting Codex and
executor aliases, foreign-thread rows, duplicate record IDs and imports with
attachment claims are now ineligible. Claims on imported records need a separate
reference review. Parent rebinding applies even when a dependent record is itself
a repaired original. Existing before-images remain recoverable through rollback
when the recorded post-repair snapshot is unchanged.

# WhatsApp final output identity

Final reply delivery uses the runtime generation, turn, item and explicit
output revision, scoped to tenant, owner, connector account, chat and thread.
Local projection IDs, parent aliases, text formatting and attachment staging
paths are not output identity. When full runtime identity is absent, an exact
non-local source event is the compatibility identity; conflicting runtime
evidence prevents a compatibility match. Unidentified legacy outputs keep
their existing idempotency behavior rather than guessing from body text.

Live, history and rollout append paths share the existing cross-process
thread-message mutation lock. Completed runtime items reuse their stored
projection. History resolves implicit thread ownership before input matching;
ambiguous local input matches remain unchanged instead of growing on each
scan. Distinct native inputs without local candidates still import separately.

The final projector and WhatsApp sender use the same logical outbox identity.
Retained older jobs can be matched by exact source event or local source ID
when their runtime evidence does not conflict. Terminal jobs, including partial
and uncertain delivery, preserve their original payload and broker receipts.
No automatic replay or historical record rewrite is introduced. PostgreSQL
uses a transaction-scoped advisory lock for first insert/legacy-alias lookup;
JSON and SQLite use the existing cross-process outbox mutation lock.

## Report-only incident review

Obtain an authorized, owner-scoped snapshot through repository reads. Do not
use message-list API endpoints that hydrate runtime history. Keep snapshots
outside the source repository. The snapshot shape is
`{ jobs: [...], messages: [...], complete: true }`; only assert completeness after
checking pagination and retention. Scope must contain `ownerUserId`, `threadId`,
`accountId`, `chatId`, `since` and `until` (ISO timestamps).

```sh
node scripts/whatsapp-output-identity-audit.mjs --snapshot /private/snapshot.json --scope /private/scope.json
```

This offline command emits a redacted review manifest and has no apply mode.
It reports hashed job/projection identities, state counts and distinct broker
receipt sets. Multiple jobs sharing one receipt set are bookkeeping aliases,
not proof of multiple physical sends. Different receipt sets still require
transport evidence to distinguish text from individual media deliveries.
Missing, conflicting or incomplete evidence always requires manual review.

## Release and recovery boundaries

- Preserve original messages, receipts, attempt counts and timestamps. Do not
  delete duplicate rows or replay old jobs as part of deploying this fix.
- Inventory existing pending aliases before rollout. This change fences new
  ensures; it does not automatically terminalize independently queued legacy
  jobs. Any recovery action requires a separately reviewed manifest and scope.
- Legacy jobs without a shared event/local ID or retained runtime identity
  cannot be safely correlated automatically. Retention remains unchanged;
  this is not an unlimited-lifetime deduplication ledger after receipts are
  pruned. Review these cases before historical backfills.
- Use a coordinated release and separately authorized restart. Confirm one
  outbox lineage across normal runtime refresh and restart. A live WhatsApp
  send is optional and requires explicit approval; offline tests never send.
- Observe `thread_output_duplicate_suppressed` and
  `connector_outbox_logical_duplicate_suppressed` events, and the existing
  `orkestr_codex_input_identity_total` conflict/ambiguity counter. New outbox
  diagnostics hash identities and never include message bodies or file paths.
- Keep the incident open until the approved production observation confirms
  no new projection growth or extra physical deliveries. Passing mocks is not
  production verification.

## Validation

Focused tests cover implicit ownership, ambiguous historical copies,
live/history/rollout convergence, concurrent fresh-process reuse, JSON/SQLite
receipt persistence, scope/revision separation, alias conflicts, a final plus
three files with successful/partial/uncertain transport, and redacted read-only
diagnostics. Existing app-server, outbox, attachment, input-identity and thread
tests exercise surrounding delivery and runtime behavior. PostgreSQL unit
coverage uses a fake pool; a real multi-host database contention check remains
a deployment-specific validation.

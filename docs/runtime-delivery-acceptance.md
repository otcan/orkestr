# Runtime and delivery acceptance review

This review covers ORK-363, ORK-471, ORK-473, ORK-490, ORK-497,
ORK-504, ORK-506 and ORK-510 against repository base `703582a0`.
Ticket descriptions and all available comments were read on 2026-09-25.
Only generic source changes and isolated tests are covered here. Operational
evidence, exact historical targets and transport receipts belong in private
operator records, outside this repository.

| Ticket | Code disposition and evidence | Remaining qualification / next action |
| --- | --- | --- |
| ORK-363 | Already implemented: `runtime-liveness.js`, `runtime-canary-evidence.js`; `runtime-liveness.test.js` covers long-running healthy work, two failed probes, checkpoint scope and exact final acknowledgement; `runtime-canary-evidence.test.js` rejects incomplete attended evidence. | Collect distinct internal/tenant canaries tied to a release and observation window, terminal input disposition, persisted final/transport receipt, stop/steering/resume observations and rollback evidence. Run the gate with `--attended`. Declined legacy terminal migrations remain excluded. |
| ORK-471 | Already implemented: durable snapshots and initial staging recovery in `outbound-attachment-snapshots.js` and `outbound-attachment-staging.js`; corresponding tests cover source removal, restart and publication failures. `outbound-staging-retention.test.js` covers authoritative references, locks, interrupted quarantine and stale-writer restoration. | Qualify retention with coordinated fenced writers and reviewed owner/thread scope. Journal quarantine does not reclaim attachment bytes. No retention activation or historical resend follows from unit tests. |
| ORK-473 | Routing already implemented; audit hardened in this change. `codex-question-audit.test.js` now rejects conflicting/duplicate answer evidence and conflicting pending-request generation aliases. Existing app-server and rollout tests cover native requests, failed legacy calls and expired answers. | Current/next CLI live compatibility and a bounded production phantom-state report remain unverified. Any annotation/reconciliation needs exact target review. Preserve ordinary direct steering: the later ticket comments supersede queued-by-default acceptance. |
| ORK-490 | Availability retry and ready-event recovery already implemented (`whatsapp-outbox-recovery.test.js`, `connector-outbox.test.js`). Audit hardened: conflicting source aliases/duplicate source IDs and conflicting, uncertain, inflight or duplicate sibling inventories cannot qualify a shadow as safely identified. | Produce a complete private incident-lineage/disposition report. Pending rows are not proof of unsent replies. Historical replay is outside this review; exact dispositions remain operator work. |
| ORK-497 | Already implemented: `codex-input-repair.js`; `codex-input-identity.test.js` covers exact scoped matching, alias conflicts, revision fences, reversible supersession, parent references, hydration, rollback, cache eviction and pagination. | Regenerate the stricter private target manifest and before-images. Previous target counts are not current eligibility. Exact apply approval and bounded canary/rollback verification remain outstanding; no historical repair performed. |
| ORK-504 | Already implemented: shared progress/final CSV preparation and readable rows; four `whatsapp.test.js` table-send cases cover both phases with success/partial failure; `whatsapp-gateway-partial.test.js` preserves sanitized HTTP-boundary evidence. | Obtain a separately approved fresh progress-table CSV receipt and readable-text observation. A generic file canary does not qualify this path. Original media failure/recovery is not established by mocks. |
| ORK-506 | Already implemented: `runtime-output-identity.js`, canonical projection reuse and outbox deduplication. `ork-506-output-identity.test.js` and `ork-506-mirror.test.js` cover changed local IDs, concurrent/restarted imports, scopes/revisions and final plus three files with delivered/partial/uncertain outcomes. `whatsapp-output-identity-audit.test.js` covers redacted report-only diagnostics. | Validate incident RCA against approved private snapshots and produce bounded containment/repair proposals. Existing independently queued legacy jobs are not automatically repaired. Separately authorized production observation and deployment-specific real PostgreSQL contention evidence remain outside mocked tests. |
| ORK-510 | Already implemented: settings control controller/journal/WhatsApp adapter and `control_reply` outbox. `settings-command-control.test.js`, `codex-thread-settings.test.js`, `codex-model-controls.test.js` and `settings-command-api.test.js` cover status-only commands, aliases, authorization, one mutation/reply, restart/uncertainty, footer hints and zero new conversation records. | Review deployment-specific metrics for unresolved operations, unknown replies and history leaks. Real WhatsApp E2E is optional, not an implicit release gate. No reimplementation or historical history deletion is required. |

## Audit changes

The question report previously accepted a completed answer with conflicting
executor aliases, or duplicated answer IDs, as resolution evidence. It also
accepted a native pending request whose generation disagreed with its request
parameters. These cases now require manual review.

The recovery report previously selected the preferred source generation alias
without checking conflicting turn/item aliases, and counted source rows only
after filtering ownership. It also accepted a delivered sibling before checking
other conflicting or uncertain lineage records. These cases now stay unresolved.
Recorded terminal delivery status is preserved; it is not a new assertion of
provider acceptance.

Both reports remain read-only. Their repository tests compare messages, runtime
where applicable, events and outbox before/after, and assert zero transport calls.
No routing, steering, replay, repair-apply, retention or settings behavior changes.

## Focused verification

Build server artifacts before running tests that import compiled API modules:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build:server
ORKESTR_HOST_BOUNDARIES=0 node --import ./test/test-bootstrap.mjs --test \
  test/runtime-liveness.test.js test/runtime-control-release-gate.test.js \
  test/runtime-canary-evidence.test.js \
  test/outbound-attachment-snapshots.test.js test/outbound-attachment-staging.test.js \
  test/outbound-staging-retention.test.js test/codex-question-audit.test.js \
  test/codex-input-identity.test.js test/codex-app-server.test.js \
  test/runtime-rollout.test.js test/connector-outbox.test.js \
  test/whatsapp-outbox-recovery.test.js test/whatsapp-recovery-audit.test.js \
  test/whatsapp-gateway-partial.test.js test/ork-506-output-identity.test.js \
  test/ork-506-mirror.test.js test/whatsapp-output-identity-audit.test.js \
  test/settings-command-control.test.js test/codex-thread-settings.test.js \
  test/codex-model-controls.test.js test/settings-command-api.test.js
node --import ./test/test-bootstrap.mjs --test \
  --test-name-pattern='sends markdown tables as CSV|table attachment detection' \
  test/whatsapp.test.js
node scripts/oss-boundary-check.mjs
git diff --check
```

The four added regression cases fail on the reviewed base and pass with these
audit changes. This evidence does not close any operational acceptance gate.

Final worker results: 285/285 focused tests and 5/5 table tests passed;
server build, OSS boundary (870 files) and diff checks passed. An initial run
before dependencies/build completion could not load required modules. A later
outbox API test needed `ORKESTR_HOST_BOUNDARIES=0` for its loopback test server;
the final full selection above passed with that isolated setting. No full
tenant suite, WebUI rebuild, live CLI/provider canary or production operation
was run for these report-only changes.

# Independent verification inventory

Baseline inspected: `a7ba6d5999c570c21cc717d78c83cf53622c22c9`.
Product reference: ADR 0003 at `2d48f841fea794c494b93c14db2d549c5eab9c89`.
This is source inspection and test design, not observed runtime acceptance.
The baseline contains only domain/demo starter crates: no published server,
authenticated fixtures, SQLite service or verified Rust build evidence.

`v2/acceptance/cases.json` records synthetic black-box scenarios and independent
oracles. Run `python3 v2/acceptance/status.py`: exit 1 means acceptance remains
pending. This command performs no server tests, provider calls or compilation.
It cannot be used as passing CI. Actual probes will use core's published DTOs
and runtime fixture controls rather than invent privileged HTTP endpoints.

## Probe contract needed from core/runtime

Publish the exact implementation head, launch/stop protocol, health readiness,
setup/session request bodies, CSRF/origin requirements and isolated cookie jar.
Supply synthetic authenticated owner/worker principals with restricted scopes;
never infer owner identity from client JSON. Fixtures need pause/release barriers,
lease generations, controlled clock/expiry and effect dispatch checkpoints.
Expose read-only inbox/event/effect counts through test-only fixtures so duplicate
admission is checked beyond response shape. Fixture controls must be disabled in
normal mode. All subprocess kills target a PID created and retained by the test;
no process-name scanning or production wrappers.

Crash probes wait for durable receipt or an explicit checkpoint before SIGKILL,
then reopen the same fresh home and compare IDs, order and sink invocation counts.
Random timing alone is insufficient. Use a synthetic sink with durable receipts;
unknown dispatch outcomes remain unknown until reconciled. Measure acceptance
and hold latency separately from inference, with ten clients, hardware and queue
delay recorded. A model saying done never substitutes for acceptance evidence.

## Legacy parity ledger (read-only source reference)

The following files were inspected for test declarations at the baseline. They
are evidence of regression intent, not claims those tests were run or passed.
Do not inherit legacy fallback behavior that conflicts with v2's explicit provider
selection. No live snapshot, credential or private profile was inspected.

| Capability | Source reference | V2 disposition and parity oracle |
|---|---|---|
| Admission/provider readiness | `test/agent-job-providers.test.js`, `test/agent-job-runner.test.js` G1/G2 | Replace; reject unconnected executor, concurrent dedupe, restart admitted work |
| Request replay/channel delivery | `test/whatsapp-replay-safety.test.js` | Optional adapter deferred; preserve claimed/sent-to-broker quarantine, no automatic uncertain replay |
| Owner/worker boundary | `test/worker-reply-input.test.js` | Replace; server-bound actor, deny cross-owner reporting |
| Cancel/effect fencing | `test/agent-job-recovery.test.js` G11 | Replace; no new effect after cancellation, pending cancellation honest |
| Exact approvals | `test/agent-job-approvals.test.js` G6/G7 | Replace; argument binding, expiry, concurrent single consumption, denial |
| Unknown effect/recovery | `test/personal-agent-acceptance.test.js` PA-R02/R03 | Replace; process death preserves evidence and quarantines unknown effect |
| Verified completion | Same file PA-R09 | Replace; changed artifact invalidates completion evidence |
| Process supervision | `test/claude-supervised-process.test.js` | Replace; grandchild exit, escalation, stale cleanup fencing, reused PGID refusal |
| Early stop and result race | `test/claude-code-instant-interrupt.test.js` | Replace; duplicate interrupt, grace-window result, coalesced input recovery |
| Import/migration | `test/personal-agent-migration-acceptance.test.js` PA-R10/R11 | New snapshot importer; interrupted import atomic, rerun idempotent; no in-place 1.x migration |
| Memory/privacy | `test/personal-agent-memory-rules.test.js`, `test/personal-agent-memory-migration.test.js` | Replace later; consent, forget/export, no transcript-to-memory conversion |
| Timers/jobs | `test/timers.test.js`, recovery schedule test | Replace later; once-per-slot/coalescing, imported timers disabled |
| Desktop/resource leases | `test/desktop-capability-broker.test.js`, PA-R07 | Retain external browser service behind scoped port; stale lease denied before browser call |
| Secrets/auth | `test/secret-links.test.js`, `test/auth-config.test.js` | Replace guarded boundary; no secret import, safe errors, origin/CSRF checks |
| Gmail/WhatsApp | `test/ork-512-gmail-oauth-start.test.js`, replay safety | Optional adapters deferred; no mandatory outside account and no live sends |
| Local Git/OXRM | ADR 0003 D08 and first-implementation scenario 2 | Verification gap: actual local provisioner/API not established; report unavailable rather than ready |
| UI/iOS/install/public boundary | First-implementation scenarios 10–12; migration sections 1/6 | Replace; native host gate pending, separate cookie/home/process namespace, no private bindings |

## Scope and remaining gaps

This is an initial V2-001/002/050 inventory, not exhaustive endpoint parity or an
implemented importer. Endpoint-by-endpoint and UI/job/storage inventories still
need expansion. No 1.x tests were executed: some launch processes or use broader
fixtures, so source reading is the safe initial reference. No acceptance case is
passing at this stage. Real provider compatibility, OXRM provisioning, native iOS
and full migration remain separate gates even after fake-provider probes pass.

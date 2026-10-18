# Orkestr 2.0 local-first migration and rollback

The old 1.x service remains authoritative throughout the prototype. V2 is an alternate service and UI. **No production release, direct data-directory sharing, live credential reuse or automatic WhatsApp delivery is authorized by branch creation.**

## Local installation

1. Check out the new branch in a **separate worktree**. Example: `git fetch origin v2/rust-rewrite && git worktree add ../orkestr-v2 origin/v2/rust-rewrite`. For development commits use a local branch tracking `origin/v2/rust-rewrite`.
2. Ensure Rust toolchain is installed. `cd v2 && cargo test --workspace` and `cargo run -p orkestr-v2-demo` smoke-test only the in-memory domain demo. This is not yet an app server.
3. When the Rust server lands, boot with `ORKESTR_V2_HOME` pointing to a fresh test-only directory and a port **different** from the 1.x installation. No auto-read of `ORKESTR_HOME`.
4. Export a consistent, backed-up **copy** of 1.x state. Dry-run importer on the copy, report unmapped entities/links, checksums and audit counts, then apply to a separate v2 database.
5. First test with synthetic accounts and read-only bridge endpoints; connect personal subscriptions and external channels only by explicitly choosing them during the v2 setup wizard.
6. Enable one scoped workflow locally. Confirm rollback by stopping v2 and returning to untouched 1.x.

## Data reconciliation

- Preserve stable original IDs as `legacy_id`/source IDs plus new typed IDs; store deterministic mapping and an import journal.
- Reconcile project, thread, child/fork, worker, task, plan, event, memory, timer, runtime session and Git/workspace relationships.
- Preserve timestamp precision and time zone; detect missing parents/cycles and quarantine them rather than fabricate relationships.
- Preserve raw messages, provenance, approved/denied/pending effects and receipts. Never map an old draft or unsent action to `sent`.
- Keep immutable raw snapshot checksums and a migration report. An importer retry must not duplicate entities or side effects.
- Treat old credentials, cookie jars, WhatsApp sessions, local browser profiles and OAuth state as **not portable by default**. Reauthorize or support an explicitly reviewed one-time handoff later.
- Import preview must be read-only: no agent turns, WhatsApp outbound, emails, Git writes, timers or scheduled tasks.

## Required acceptance matrix

| Check | How to prove | Exit |
|---|---|---|
| Graph fidelity | Copy all root/child/fork threads; compare edge counts and source IDs | No lost edges; exceptions enumerated |
| History fidelity | Compare message count, order, actors, original timestamps and binary asset references | Differences reported and accounted for |
| Job recovery | Admit, SIGKILL, restart; verify deterministic task state | No false "running" or duplicate effect |
| Approval | Deny-by-default, resume approved exact effect once | No unauthorized execution |
| Delivery | Simulated WhatsApp/email duplicate and crash cases, then opt-in live sandbox | No double send |
| Memory | Project and user isolation, consent, delete/correct, replay | Scoped, attributed, reversible |
| Provider sessions | Codex/Claude/local capability probing, safe fork/resume/interrupt | No silent provider/session substitution |
| UI | Long conversation, nested navigation, streaming, reconnect and mobile Safari | No lost draft/input; accessible |
| Security | Secrets exclusion, malicious project access, SSRF and sandbox limits | No cross-scope access |
| Local cutover | Run 1.x and v2 separately; stop v2 and return to 1.x | Existing 1.x unchanged |

## Rollback

V2 has distinct process/service name, port, data directory, cookie domain or namespace, and environment config. Stop v2, disable its connector routes, and restart/use 1.x from its original state. **Do not attempt simultaneous writes to one WhatsApp identity or agent run ledger.** If any real outbound action occurred during local testing, ledger receipts must be reconciled before returning the same channel to 1.x.

No date-based forced sunset. Replace 1.x only after a complete side-by-side parity report and explicit owner acceptance.

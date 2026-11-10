# OP-07: concurrent SQLite initialization

## Reproduction and fix

Synthetic tests against main `d0ff57cca74e05b183d4e243c26d4e9a199efd5b`
reproduced three failures before the fix:

- Hold an exclusive writer on a legacy database, open the memory store in a
  child, then release the writer: child exits 1 instead of 0 with
  `memory_store_unavailable` (503).
- Repeat through `openAgentJobDb`: `database is locked`, SQLite error 5, at
  `agent-job-store.js:133` (`pragma journal_mode = WAL`), assertion `1 !== 0`.
- Start two memory openers together on a fresh database: one reports the same
  unavailable error, assertion `1 !== 0`. The already initialized variant passed.

Installing `busy_timeout` before WAL fixes the held-writer case but is
insufficient: synchronized fresh openers still failed (iteration 11 of a
separate probe), again at WAL initialization. SQLite may return BUSY from a
competing journal-mode upgrade without invoking its busy handler.

Initialization now installs the busy handler first and retries only the WAL
operation for primary/extended SQLITE_BUSY within one monotonic 10-second
deadline. Each retry uses the remaining timeout. Other errors propagate;
persistent contention remains unavailable. Failed initializations close their
uncached connection. Ordinary transactions retain the existing 10-second busy
timeout and synchronous FULL durability.

## Evidence and limits

`test/personal-agent-memory-init-contention.test.js` covers the held-writer
cases and synchronized fresh/already initialized processes. Both writers must
return the same consented record, one as an idempotent retry; legacy data must
survive. All four probes pass with the fix. A separate repetition passed 100
fresh-plus-initialized pairs (400 child processes); this is a bounded stress
sample, not a claim that arbitrary database contention cannot fail.

`test/agent-job-sqlite-initialization.test.js` uses a fake clock and connection
to check ordering, extended BUSY, deadline exhaustion and immediate propagation
of corruption/authorization/LOCKED errors. Existing memory durability, consent,
flag-off and incompatible-storage tests remain applicable. Fixtures use only
temporary databases and synthetic owners/content, with no provider calls.

## Rollback and migration

No table, migration, consent or API contract changes. There is still one
Agent Job database. Feature-off behavior retains its existing schema. Revert
the initialization change to roll back; do not remove database files or memory
records. Reversion restores the race and does not require a data migration.

# Desktop gate operational readiness

Reviewed gate: `11225813e5dcb087d04a9d83d0aebbee7e93512a` (PR116).
Read-only inspection found deployed release `v0.1.0-alpha.213` still uses the
legacy store. No installed state, browser, helper or service was changed.
This document describes preparation, not an authorized deployment procedure.

## Actual source-defined writers

| Entry | Lease access | Transition requirement |
| --- | --- | --- |
| Web desk, first-thread wizard, operations UI | HTTP acquire/release via `apps/server/src/modules/browsers/browsers.controller.ts`; heartbeat endpoint also writes | Pause API mutation ingress and drain in-flight handlers |
| `apps/cli/src/desktop-command.js` | HTTP acquire through same controller | Quiesce CLI and other API clients; replacing CLI alone does not reload server |
| `packages/core/src/linkedin-mcp-runtime.js`, `scripts/linkedin-mcp-runtime.mjs` | Direct imported acquire/heartbeat/release; periodic heartbeat | Drain browser work plus heartbeat/release lifecycle; long-running imports retain old code |
| `packages/core/src/tenant-api-agent-tools.js` through tenant agent | Direct imported acquire | Pause tool dispatch and drain in-flight writers |
| `scripts/real-wa-e2e.mjs` | Diagnostic HTTP acquire/heartbeat/release | Keep diagnostic inactive during adoption |

Browser library manager/operator/capability broker use access/status checks.
Standalone `scripts/browserctl.mjs` reads the JSON store; resource lifecycle
watchdog also reads it. These are not new-gate action authorization. Preserve
browser processes rather than restarting them to migrate a lease file.

The factory resolves `ORKESTR_DESKTOP_LEASE_FILE`, otherwise
`ORKESTR_HOME/desktop-leases.json`. Privately resolve every writer's configuration
without printing environment secrets. Arbitrary operator imports are not covered
by repository search. Service PID/working-directory metadata confirms HTTP and
Codex executor units are distinct, but cannot prove all loaded modules or that
HTTP shutdown preserves executor children. No process introspection, environment
or installed lease contents were read for this rehearsal.

## Proposed quiesce/adoption sequence (unexecuted)

1. Identify every writer process and store override, including external API
   clients and retained direct imports. Establish a maintenance ingress gate and
   drain in-flight actions and scheduled heartbeats.
2. Preserve executor sessions. Do not stop browser, bridge, native executor or
   Codex app-server units. Before any HTTP reload, independently establish that
   its shutdown cannot terminate those sessions/children. If unavailable, add a
   reviewed session-preserving drain seam first. This is an operational blocker,
   not a reason to kill executor sessions.
3. With all legacy writers demonstrably quiescent, retain byte-exact state and
   lock evidence plus metadata/hashes privately. A legacy mkdir lock may only be
   removed after proof no owner remains. Never steal by age or unlink a new
   persistent flock inode.
4. Strictly validate legacy JSON. New init adds lock identity only, preserving
   existing IDs/tokens/counters/history and authority; it does not renew or revoke.
   Invalid state must fail closed, not normalize/reset.
5. Adopt using one new writer, then reload all direct-import processes before
   reopening dispatch. Confirm no old writer remains. Resume authenticated
   clients only after binding checks, preserving executor sessions.
6. Retain source and lock device/inode evidence. Do not roll code back to legacy
   writers against adopted state; keep ingress closed pending reviewed recovery.

OS ownership, UID and flock are operational identity/serialization, not product
user authentication or desktop scope. Exact authenticated binding is still
required by the synchronous action gate. This is not remote browser fencing.

## Offline restore/revocation seam

Restoring JSON and even copying the lock file onto fresh inodes intentionally
refuses identity validation. Never silently strip lockIdentity from active leases,
rebind restored authority, or treat a copied lock marker as authorization. PR116
has no reviewed operational recovery command.

Smallest proposed mechanism: an explicit offline fresh-target **revoke-all**
transformation. Validate source, retain byte-exact original evidence, preserve
counter/IDs/tokens/history/unknown fields, mark all unreleased records released
with an explicit restoration reason, then omit old lockIdentity from the revoked
output only. Fresh gate init adopts this inactive state; every old binding fails.
Future authenticated acquire requires a higher generation and new token. Already
released records remain unchanged. No grant or renewal is inferred.

The test-only transformation demonstrates policy; it is not an operational file
tool. Production implementation needs review for proven offline exclusivity,
bounded nofollow reads, original evidence, fresh-target publication, metadata,
durability, interruption cleanup and receipts. Session preservation/drain and
this recovery mechanism remain unexecuted/unqualified.

## Disposable rehearsal

Export the exact gate source and package metadata to a private fresh directory,
without dependency installation, then run:

```sh
DESKTOP_GATE_SOURCE=/absolute/private/export node --test v2/local-install/tests/desktop_gate_rehearsal.test.mjs
```

Four tests pass: legacy adoption and byte-stable reinit, copied state/lock refusal,
proposed revoke-all restore with old-binding rejection and fresh generation,
and legacy mkdir-lock refusal. Stores live only in temporary owned directories
and are cleaned. This does not qualify live adoption, service drain, production
restore, remote fencing or power-loss durability.

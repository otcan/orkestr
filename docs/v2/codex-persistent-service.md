# Persistent Codex service, first composition boundary

This additive service keeps one dropped-UID ordinary Rust UI/API process alive
while its one configured owner's Deep conversation uses explicit bounded
execution windows. The old `codex_bounded` v1 entrypoint and package are unchanged.
The service is not activated by importing these modules or by preparing a package.

The implementation includes the local protocol, durable budget ledger, relay
adapter and persistent manager. It remains opt-in: a matching protected package,
ordinary Runtime composition and independent acceptance are required for beta.

## Fixed limits and ownership

Every window has 900 seconds, 32 authenticated outer connection attempts and
64 MiB combined-direction bytes. Both existing inner limits and the shared outer
limit remain. Normal work stops with **30 seconds, four attempts and 1 MiB**
reserved inside those totals for shutdown. Encrypted traffic cannot be classified
as cancellation by its contents: this margin permits cleanup, it does not prove
genuine provider Stop. Failure to obtain terminal and reap evidence remains
reconciliation. There is no automatic replacement window.

Core owns authenticated owner/input/run/terminal authority. The root manager
owns the fixed process/peer boundary and conservative egress accounting. Neither
the browser nor the local protocol supplies programs, paths, provider tokens,
account choices or resource limits. The same persistent private native state,
strict FD3 native writer and FD4 resume metadata flow remain provider-owned.

The root manager is the sole writer of its root-private SQLite ledger. FULL
commits precede admission and forwarding. Byte credits are reserved in 16 KiB
increments, shared across both directions and all replacement natives in that
window. At most 4096 byte-credit rows exist per window. Unused credits and
incomplete sends are never refunded. `reserved_bytes` is a conservative durable
upper bound; live observed bytes are not claimed as crash-durable exact billing.
Connection attempts are individually committed. A repeated reservation never
authorizes another send.

Opening a ledger after manager restart marks every unfinished window as requiring
reconciliation, even if it died before the first provider write. Retired history
is preserved. Both fixed Core wall deadlines and a same-boot monotonic deadline
are checked; transport delay cannot restart the 900-second timer. Boot changes,
clock rollback, a wall/monotonic offset change greater than one second, exhausted limits or missing ownership refuse
further forwarding. A successful explicit new window may reset its own budget
only after the exact predecessor is retired. Additional inputs in the same active
window do not change generation, budgets, creation time or deadline.

## Rust to manager protocol v1

One root-owned Unix stream endpoint accepts only the exact manager-owned Rust
server PID/start/UID/executable. Peer authentication precedes parsing. Each
connection carries one big-endian u32 byte length, followed by at most 8192 bytes
of UTF-8 JSON, then one similarly framed reply. Duplicate keys, extra fields,
non-finite numbers, oversized/deep frames and trailing frame bytes refuse. The
transport must use an absolute bounded read/write deadline and close every peer.

Every request has `version:1`, `operation`, `request_id` (Core's bounded request
key), `owner_id` and `conversation_id` (exact canonical UUIDs matching the fixed
package). Operations add these exact fields:

| Operation | Fields |
| --- | --- |
| `status` | none; read-only, never opens/renews a window |
| `admit` | `window_id`, `generation`, `expected_generation`, `input_message_id`, `input_event_id`, `input_request_key`, `predecessor_window_id`, `opened_at_ms`, `work_deadline_ms`, `expires_at_ms` |
| `drain` | `window_id`, `generation` |
| `bind_child` | `window_id`, `generation`, `broker_pid`, `broker_start`, `bind_deadline_ms`; locators and original caller time bound only |
| `retire` | `window_id`, `generation`, `outcome` (`accepted` or `stopped`), `run_id`, `terminal_event_id` |
| `uncertain` | `window_id`, `generation`, `reason` (`runtime_refused`, `auth_revoked`, `cleanup_unknown`, `server_lost`) |

`admit` is sent only after current browser authentication/Origin/CSRF and a
durable Core window/input admission. Its three times are copied from that exact
Core admission: work deadline is opened+870000 ms, hard expiry opened+900000 ms.
A new window has generation expected+1 and exact retired predecessor (null for
the first). An input for the current active window has generation equal to
expected, the same original deadlines, and null predecessor in this request.
Historical identical admission replay returns evidence with `fresh_window:false`;
it must never recreate egress or a provider. Conflicting idempotency or a reused
input/event refuses. Manager ACK binds owner/conversation/window/generation,
boot id, original opened/work/hard deadlines and all six exact limit fields.
Runtime binds the private execution credential and checks that ACK. Typed
metadata-only initialization may occur while Core is Opening, under the existing
one-use metadata grant. Core activates LAST after the exact native metadata bind;
inference, turn-start and effects remain forbidden before Active. A failure between
the two durable stores is reconciliation, not automatic retry or a new budget.

`drain` immediately prevents further normal input admission. Runtime continues
the existing exact-run Stop/acceptance/cleanup paths within the original limits.
`retire` is a statement by the authenticated, source-pinned Rust process that
its exact Core terminal+retirement transaction succeeded. The manager must also
close/join the window's relay pool and verify its original native descendants
gone before recording retirement. A boolean, PID, status label or browser DTO
does not replace either proof. Normal aligned expiry fences all bytes/admission
but retains the pending proposal and original cleanup observations. Later
metadata-only retirement is allowed only after the still-authenticated Core
accepted/stopped transaction and the manager's original clean proof. Clock/boot
uncertainty, forced cleanup or restart cannot regain this authority. Existing
ordinary run/control routes do not change.

All protocol integers are less than 2^53; generation zero denotes idle and new
windows start at one. UTF-8 is strict. Canonical bytes use sorted keys, no spaces,
literal non-ASCII text and no non-finite numbers, matching the published Core ABI.

The source-pinned service broker pauses itself with SIGSTOP before native launch
or FD3 handoff. Runtime calls `bind_child` immediately after spawn, before waiting
for the handoff or supplying the resumed FD4 metadata. The manager verifies the
exact child PID/start/UID, direct Rust parent, interpreter and closed no-site
entry argv; captures its original pidfd; then alone sends pidfd SIGCONT. Exact
bind replay cannot continue twice. A failed bind makes the window uncertain;
the caller must reap its stopped child. No empty tree snapshot creates proof.

`bind_deadline_ms` is a required positive UTC Unix millisecond integer below
2^53, derived from Runtime's original absolute deadline of at most five seconds.
The manager maps the remaining time once and caps it by connection acceptance
plus five seconds and the exact window's work cutoff. Frame reception still has
its original one-second bound. Pause, source/identity validation and reply share
that deadline, with 100 ms reserved for the reply; a late pause or late final
validation never releases the child. Lost replies remain ambiguous and are not
retried. Old/new mixed control schemas refuse rather than invent a fresh budget.

The fixed shell entry wrappers invoke the pinned interpreter with `-I -S -B`.
`codex_service/entry.py` checks protected metadata and the complete initial import
closure before importing the package validator, which validates every remaining
module, server/native binary, UI file and fixed dependency before dispatch.
The old bounded-v1 entry is unchanged. No site hooks or ambient Python paths run.

The manager never exits merely because a window expired. An unexpected Rust
child exit, including exit zero, durably marks unfinished work uncertain and
returns a nonzero service status. Planned shutdown keeps the private channel
responsive while Rust drains, then joins root-owned egress and children. The
service's external process supervisor should use ordered manager-first shutdown.

Replies are bounded metadata only: fixed success/refusal category, the window
receipt and a `fresh_window` boolean for admission. Status includes generation,
window id/state, attempts, reserved bytes, boot and original deadlines. A manager failure
must leave the UI alive when possible but execution unavailable; a lost root
manager still enforces owned server/native parent-death cleanup.

## Qualification

The ledger suite uses disposable SQLite files and a fixed synthetic Python child
that exits immediately after a committed reservation. It exercises same-window
inputs, exact replay, scope/predecessor refusal, restart uncertainty, deadline
races, both directions and concurrent 64 MiB exhaustion. It invokes no provider,
account, browser, service or network destination:

```sh
cd v2/provider-broker
python3 -B -m unittest -v test_codex_service_ledger test_codex_service_clock test_codex_service_process
```

Private package sealing, authenticated peer/framing tests, persistent child
lifecycle, root-independent cleanup, Core/Runtime integration, UI/auth credential
rotation, restart/cutoff negatives, and one exact-package selected-account trial
remain distinct gates. This document does not grant actual provider activation.

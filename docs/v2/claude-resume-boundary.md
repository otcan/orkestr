# Claude accepted-turn resume boundary

Claude 2.1.295 help supports explicit `--resume <session-id>` and
`--replay-user-messages`. Read-only inspection of its installed embedded engine
also found the producer/schema `user_message_uuid` join key on success/error
results. The assistant schema explicitly says this key need not occur on every
frame. An echoed user message, stable session ID, initialization event or frame
UUID alone therefore cannot bind every subsequent frame to an input.

The selected boundary is a **new owned native process and broker per accepted
turn**. `ClaudeConfiguration.resumed_session(ResumeSpec)` builds fixed
`--resume` options for the exact prior generated native UUID. It does not use
`--continue`, fork, a browser-selected UUID or a new identity. PID changes are
intentional. Each process/channel accepts only one CommitExecution. Runtime
must allocate a new socketpair and unique child-lineage token; an old handoff
must never be reset or receive another descriptor.

`claude_resume.retire` is a private in-process lifecycle hook. It checks the
actual session/channel/child association, a terminal result UUID, successful
owned wait, closed reader, and a trusted parent writer-close notification. It
then calls a **trusted launcher-only** completion-and-owner-acceptance callback
with the exact session, outer correlation and terminal UUID. Failure quarantines
the old session. The non-copyable/non-serializable spec is consumed once, before
validation/launch can fail. Neither the callback boolean nor this Python object
is Core dispatch authority. There is no JSON operation to mint/import a spec.
The parent owns the transferred FD, so its close notification is a trust boundary,
not a claim that Python can inspect an FD in another process.

Resumed input additionally needs a canonical new user-frame UUID. Each accepted
assistant/result frame must echo that exact UUID in `user_message_uuid`; if the
plural key exists it must contain only that UUID. Missing, mixed, historical or
foreign evidence quarantines the channel, including unseen late frames. Nothing
is silently discarded and then relabelled. UUID/result evidence is retained in
the sanitized output. This deliberately refuses producers/assistant sequences
that omit the join key; first real resume acceptance must verify compatibility,
and may require a reviewed completion-only output mode rather than weakening
correlation.

## Current executable handoff and remaining lifecycle gates

The fixed broker entry now supports
`claude_server.py resume-owned-session --protocol orkestr-v2-provider-broker-v1`.
It requires a new fd3 sole-writer handoff and a separate inherited fd4 bootstrap.
`claude_bootstrap.receive(config, descriptor=4)` accepts only a connected AF_UNIX
stream whose peer is the direct same-UID parent. Within one second it consumes
exactly `claude-resume-v1\0` followed by a canonical 36-byte ASCII UUID and EOF.
That record selects an identity; it is not Core authority. The private parent
must derive it from the exact issued accepted-session grant and owned reaped
session ticket, never browser JSON. The returned one-use ResumeSpec binds the
exact configuration object and is consumed by `resumed_session` before launch.
The hashed `claude-package.json` includes bootstrap/resume dependencies.

Runtime must establish prior durable completion plus owner acceptance, close the
old reader/writer and fully reap the old owned process tree before using a fresh
Core-issued metadata/attachment grant. New child, socketpairs, FD writer and Arc
lineage are mandatory. No old transport reset, generation arithmetic, EOF-only
proof or automatic retry is permitted. Core grant eligibility and Runtime
retirement must be checked against their current exact source independently.

The older in-process `claude_resume.retire` helper checks a directly owned native
child's zero exit; it is not the current external broker tree-reap proof. Runtime
must use its consuming owned-child retirement proof and the reviewed broker clean
EOF/ECHILD exit73 contract. A broker ACK, normal exit0, forced kill or timeout
cannot substitute. Compatibility probes with private operator ResumeSpec do not
qualify ordinary Core-issued continuation.

Metadata control initialize ACK proves process initialization only. It contains
no observed native UUID. The current Core/Runtime initialization-versus-observation
split must remain: consume the actual turn capability, then validate emitted
system/init and durably observe that exact binding before Started/output. A new
resumed process still follows the reviewed readiness path; this document grants
no authority to skip it.

## Native Stop remains a separate missing hook

Current ClaudeChannel admits initialize metadata and one CommitExecution only.
It rejects CancelExecution and arbitrary control_request, including interrupt.
No genuine pinned-native interrupt ACK/terminal trace has been authored or run by
this lane. Adding Stop requires a separate closed control operation derived from
Core's exact issued cancellation receipt, the current same-child/input identity,
and every actual suffix under the cancellation fence. Native control ACK is not
terminal or cleanup proof. Local exit must not synthesize an interrupted result.
Root's bounded native protocol probe and Runtime's typed cancellation composition
must define which actual terminal proves interruption; otherwise Stop remains
unknown until owned cleanup is established, without claiming native completion.

Synthetic tests launch two distinct fake native PIDs with an unchanged UUID,
transfer the sole writer, complete the first child wait, exercise single-use
resume, and reject identical prior terminal, unseen old terminal and unbound/late
assistant frames. These tests are not actual Claude, durable Store composition,
subscription authentication, or real acceptance evidence.

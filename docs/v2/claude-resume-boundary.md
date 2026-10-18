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

## Integration prerequisites (unexecuted)

The ordinary current Core metadata grant describes a Starting session without
native readiness. It cannot authorize setup of an already Ready resumed binding.
Core must issue an additive, private resume setup/attachment capability linking
accepted completion, current exact binding and native UUID. Runtime must consume
it while constructing a new broker and must consume a new dispatch capability
for the next actual stdin write. No fabricated Starting state or generation
increment is permitted. There is intentionally no executable resume entrypoint
in `claude_server.main` yet: crossing a new broker process needs Runtime/Core's
opaque private bootstrap, not serialized Python capability or caller JSON.

Synthetic tests launch two distinct fake native PIDs with an unchanged UUID,
transfer the sole writer, complete the first child wait, exercise single-use
resume, and reject identical prior terminal, unseen old terminal and unbound/late
assistant frames. These tests are not actual Claude, durable Store composition,
subscription authentication, or real acceptance evidence.

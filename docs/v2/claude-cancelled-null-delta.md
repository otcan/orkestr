# Cancelled Claude partial-stream closure

The pinned Claude Code 2.1.295 executable, SHA-256
`4503bfe11a6c7fcc1e0b39b5e0d347c04248f750b03b0977b3ad6b531fe6f358`,
closes an unfinished partial stream before forwarding its result. Static source
inspection finds the `ok` partial-stream adapter's `w` helper calling
`Dl(n, null, null, Ol(R))` at byte offset 241362891. The `Dl` constructor at
241365296 emits a `message_delta` with null `stop_reason`, `stop_sequence`,
`stop_details` and `container`, followed by `message_stop`. The result path calls
`closeAtTurnEnd` before forwarding the result at 241523712. This source evidence
does not establish which operand caused any particular live guard refusal.

The broker accepts this null stop reason only after an interrupt for the current
input has already been issued. The existing native session, API message, optional
input echo, event identity, block ordering, replay and resource limits still
apply. Stop sequence, details and container must remain null or absent. Other
stop-reason values retain their existing allowlist; null is not added to that
global list. Non-null details, tools, unknown fields and unanchored or foreign
frames remain refused.

These closing frames emit no progress and supply no control acknowledgement,
interrupted terminal result, owner acceptance or process cleanup evidence. Even
after `message_stop`, the channel requires the independently correlated native
interrupted result. The ordinary Runtime continues to require its owned process
cleanup proof before publishing Stopped.

`test_claude_cancelled_null_delta.py` uses synthetic frames only. It covers the
source-shaped close, separate ACK/result order, current cancellation, identity,
replay, block state, malformed metadata, existing resource budgets and success
or post-terminal substitution. It does not execute the provider or resolve an
account.

# Claude headless system metadata

Claude Code 2.1.295 emits `system/thinking_tokens` and `system/status` with
`status: requesting` during ordinary headless turns. These are distinct from
the genuine `system/init` observation. The broker consumes two exact shapes
without forwarding any Runtime observation:

- `thinking_tokens`: current `user_message_uuid`, integer `estimated_tokens`
  and `estimated_tokens_delta` in `[0, 2^53)`.
- `status/requesting`: `user_message_uuids` equal to the singleton current
  consumed input UUID.

Both require an initialized, submitted turn with genuine native init already
observed, the current native session, and a fresh nonnil canonical event UUID.
Their UUIDs share the existing 128-event telemetry budget and cannot reuse
assistant, control-notice or terminal identities. Extra fields, other status
values, foreign or missing input scope, replay, invalid counters and overflow
remain refused.

Metadata cannot grant readiness, Progress, success, owner acceptance, a control
ACK, or Stopped. It can be discarded during control or after its terminal
without changing that terminal. The original init, success, correlated-error
and interrupted-result codecs are unchanged. Other system subtypes and duplicate
init remain refused.

This fixes a source-proven compatibility gap. It does not establish which
system subtype caused any previous failure that retained only a frame kind.
